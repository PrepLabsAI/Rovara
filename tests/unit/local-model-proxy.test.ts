// Port lane L9a, K1: the local model proxy's pieces that need no network: the token book, the usage reader, the request guard (Cloud's rules), the text
// scrubber, the routes, the gateway's route table and the callback capability action.
import { describe, expect, it } from "vitest";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import {
  ALLOWED_BETAS, DEFAULT_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS, ModelTokenBook, NO_MODEL_GRANTS, RequestNotAllowed, TOKEN_PREFIX, UsageCollector,
  checkRequestBody, checkRequestHeaders, capabilityModelGrants, localRoute, scrubProviderText, upstreamUrl, usageOf, DEFAULT_PROVIDER_ENDPOINTS,
  type ModelGrant,
} from "../../packages/broker/src/local/model-proxy/index.js";
import { fakeKey, loadGatewayRelay, sha256 } from "../support/model-proxy-world.js";

const grant = (over: Partial<ModelGrant> = {}): ModelGrant => ({ workspaceId: "ws-1", operationId: "op-1", routes: [localRoute("anthropic", "claude-test").route], ...over });

describe("the proxy token book", () => {
  it("mints a token no key can be read from, good for its time and then refused", () => {
    let now = 1_000_000;
    const book = new ModelTokenBook({ now: () => now, ttlSeconds: 300 });
    const { token, expiresAt } = book.mint(grant());
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(expiresAt).toBe(now + 300_000);
    const found = book.lookup(token);
    expect(found.ok && found.record.workspaceId).toBe("ws-1");
    now += 299_999;
    expect(book.lookup(token).ok).toBe(true);
    now += 1;
    expect(book.lookup(token)).toEqual({ ok: false, reason: "expired" });
    expect(book.lookup(token)).toEqual({ ok: false, reason: "unknown" });
  });

  it("keeps a digest of a token, not the token: the digest itself is no token, and a token one character off is none", () => {
    const book = new ModelTokenBook();
    const { token } = book.mint(grant());
    expect(book.lookup(sha256(token))).toEqual({ ok: false, reason: "unknown" });
    expect(book.lookup(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toEqual({ ok: false, reason: "unknown" });
    expect(book.lookup("")).toEqual({ ok: false, reason: "unknown" });
  });

  it("gives each mint a different token and ends an operation's tokens together, keeping its spend", () => {
    const book = new ModelTokenBook();
    const one = book.mint(grant());
    const two = book.mint(grant());
    const other = book.mint(grant({ operationId: "op-2" }));
    expect(one.token).not.toBe(two.token);
    book.ledger("op-1").spentMicros = 42;
    expect(book.revokeOperation("op-1")).toBe(2);
    expect(book.lookup(one.token).ok).toBe(false);
    expect(book.lookup(two.token).ok).toBe(false);
    expect(book.lookup(other.token).ok).toBe(true);
    expect(book.ledger("op-1").spentMicros).toBe(42);
    book.forgetOperation("op-1");
    expect(book.ledger("op-1").spentMicros).toBe(0);
  });

  it("refuses a lifetime the worker could not renew in time", () => {
    expect(DEFAULT_TOKEN_TTL_SECONDS).toBeGreaterThan(MIN_TOKEN_TTL_SECONDS);
    expect(() => new ModelTokenBook({ ttlSeconds: 60 })).toThrow(/at least 150 seconds/);
    expect(() => new ModelTokenBook({ ttlSeconds: Number.NaN })).toThrow();
  });
});

describe("reading usage from the provider's answer", () => {
  const sse = (...events: unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

  it("reads Anthropic's start and delta, later numbers replacing earlier ones", () => {
    const collector = new UsageCollector("anthropic-messages");
    collector.push(sse({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } }, { type: "content_block_delta" }, { type: "message_delta", usage: { output_tokens: 99 } }));
    expect(collector.finish()).toEqual({ input: 10, output: 99, cacheRead: 20, cacheWrite: 3 });
  });

  it("reads OpenAI's chat chunk and responses event without counting cached tokens twice", () => {
    const chat = new UsageCollector("openai-completions");
    chat.push(sse({ choices: [{ delta: { content: "x" } }], usage: null }, { choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } } }));
    expect(chat.finish()).toEqual({ input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
    const responses = new UsageCollector("openai-responses");
    responses.push(sse({ type: "response.output_text.delta" }, { type: "response.completed", response: { usage: { input_tokens: 70, output_tokens: 8, input_tokens_details: { cached_tokens: 20 } } } }));
    expect(responses.finish()).toEqual({ input: 50, output: 8, cacheRead: 20, cacheWrite: 0 });
  });

  it("reads a line that arrives in pieces, ignores what is not an event, and drops one enormous line", () => {
    const collector = new UsageCollector("anthropic-messages");
    const line = `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n`;
    const bytes = new TextEncoder().encode(`: ping\n\nevent: x\ndata: not json\ndata: [DONE]\n${line}`);
    collector.push(bytes.subarray(0, 40));
    collector.push(bytes.subarray(40, 90));
    collector.push(bytes.subarray(90));
    expect(collector.finish()).toEqual({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
    const big = new UsageCollector("anthropic-messages");
    big.push(new TextEncoder().encode(`data: ${"x".repeat(4 * 1_048_576 + 10)}`));
    big.push(sse({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect(big.finish()).toBeUndefined();
  });

  it("reads a whole answer, and says nothing was reported when nothing was", () => {
    const whole = new UsageCollector("openai-completions");
    whole.whole({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } });
    expect(whole.finish()).toEqual({ input: 9, output: 2, cacheRead: 0, cacheWrite: 0 });
    const none = new UsageCollector("anthropic-messages");
    none.whole({ content: [] });
    expect(none.finish()).toBeUndefined();
    expect(usageOf("anthropic-messages", { input_tokens: -1, output_tokens: "7" })).toBeUndefined();
    expect(usageOf("openai-responses", "text")).toBeUndefined();
  });
});

describe("the request guard (Cloud's proxy rules)", () => {
  it("lets through the fields each wire shape allows, field for field", () => {
    expect(() => checkRequestBody("anthropic-messages", { model: "a", messages: [], max_tokens: 1, stream: true, system: "s", temperature: 1, thinking: {}, output_config: {}, tool_choice: {}, tools: [], metadata: { user_id: "u" } })).not.toThrow();
    expect(() => checkRequestBody("openai-responses", { model: "a", input: [], stream: true, store: false, max_output_tokens: 1, reasoning: {}, include: [], prompt_cache_key: "k" })).not.toThrow();
    expect(() => checkRequestBody("openai-completions", { model: "a", messages: [], stream_options: { include_usage: true }, reasoning_effort: "low", provider: { allow_fallbacks: false, only: ["x"] } })).not.toThrow();
  });

  it("refuses a field that moves the call, adds a credential, or turns one call into several", () => {
    const refused: Array<[Parameters<typeof checkRequestBody>[0], Record<string, unknown>, RegExp]> = [
      ["anthropic-messages", { model: "a", api_key: "x" }, /field api_key/],
      ["anthropic-messages", { model: "a", api_base: "http://evil.example.test" }, /field api_base/],
      ["anthropic-messages", { model: "a", base_url: "http://evil.example.test" }, /field base_url/],
      ["anthropic-messages", { model: "a", extra_headers: { a: "b" } }, /field extra_headers/],
      ["openai-completions", { model: "a", extra_body: {} }, /field extra_body/],
      ["openai-completions", { model: "a", organization: "o" }, /field organization/],
      ["anthropic-messages", { model: "a", fallbacks: ["b"] }, /fallbacks/],
      ["openai-completions", { model: "a", context_window_fallbacks: [] }, /context_window_fallbacks/],
      ["openai-completions", { model: "a", models: ["a", "b"] }, /field models/],
      ["openai-completions", { model: "a", route: "fallback" }, /field route/],
      ["anthropic-messages", { model: "a", metadata: { user_id: "u", tags: ["x"] } }, /metadata/],
      ["anthropic-messages", { model: "a", metadata: "x" }, /metadata/],
      ["openai-completions", { model: "a", provider: { allow_fallbacks: true } }, /provider routing/],
      ["openai-completions", { model: "a", provider: { order: ["x"] } }, /provider routing/],
      ["openai-completions", { model: "a", provider: { allow_fallbacks: false, api_key: "k" } }, /provider routing/],
      ["openai-responses", { model: "a", messages: [] }, /field messages/],
    ];
    for (const [api, body, message] of refused) expect(() => checkRequestBody(api, body), JSON.stringify(body)).toThrow(message);
    expect(() => checkRequestBody("openai-completions", { model: "a", metadata: {} })).toThrow(RequestNotAllowed);
  });

  it("refuses proxy-control and billing headers, and a beta it does not know", () => {
    for (const name of ["x-litellm-api-key", "x-litellm-metadata", "openai-organization", "openai-project", "x-api-key-override"]) expect(() => checkRequestHeaders({ [name]: "x" }), name).toThrow(/header/);
    expect(() => checkRequestHeaders({ "anthropic-beta": [...ALLOWED_BETAS].join(", ") })).not.toThrow();
    expect(() => checkRequestHeaders({ "anthropic-beta": "context-1m-2025-08-07" })).toThrow(/anthropic-beta/);
    expect(() => checkRequestHeaders({ "anthropic-beta": "interleaved-thinking-2025-05-14,computer-use-2025" })).toThrow(/anthropic-beta/);
    expect(() => checkRequestHeaders({ "x-api-key": "t", "content-type": "application/json", "anthropic-version": "2023-06-01" })).not.toThrow();
  });
});

describe("what the proxy shows of a provider's error", () => {
  it("removes the key, anything key-shaped and control characters, and shortens", () => {
    const key = fakeKey("sk-ant");
    const text = scrubProviderText(`Incorrect API key provided: ${key}. Also sk-proj-abcdef1234567890 and Bearer ${key}\u0000\nnext line`, key);
    expect(text).not.toContain(key);
    expect(text).not.toContain("abcdef1234567890");
    expect(text).toContain("[secret]");
    expect(text).not.toMatch(/\p{Cc}/u);
    // A provider that masks a key still shows its ends: the whole word goes.
    const masked = scrubProviderText(`bad key ${key.slice(0, 12)}...${key.slice(-6)} (${key.slice(-8)}) end`, key);
    expect(masked).not.toContain(key.slice(0, 8));
    expect(masked).not.toContain(key.slice(-8));
    expect(masked).toContain("bad key");
    expect(scrubProviderText("x".repeat(1_000), key)).toHaveLength(300);
  });
});

describe("routes", () => {
  it("names a model for the proxy and for the worker, and keeps each provider on its own wire shape", () => {
    const anthropic = localRoute("anthropic", "claude-test");
    expect(anthropic.route).toEqual({ alias: "anthropic/claude-test", provider: "anthropic", model: "claude-test", api: "anthropic-messages" });
    expect(anthropic.workerRoute).toEqual({ alias: "anthropic/claude-test", api: "anthropic-messages", catalog: "claude-test" });
    expect(localRoute("openai", "gpt-test").route.api).toBe("openai-responses");
    expect(localRoute("openrouter", "vendor/model-test").route.alias).toBe("openrouter/vendor/model-test");
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "anthropic", "anthropic-messages")).toBe("https://api.anthropic.com/v1/messages");
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "openai", "openai-responses")).toBe("https://api.openai.com/v1/responses");
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "openrouter", "openai-completions")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "openrouter", "anthropic-messages")).toBeUndefined();
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "anthropic", "openai-responses")).toBeUndefined();
    expect(upstreamUrl(DEFAULT_PROVIDER_ENDPOINTS, "openai", "anthropic-messages")).toBeUndefined();
  });
});

describe("model access as a callback action", () => {
  const secret = Buffer.alloc(32, 7);
  it("is an action a capability must list, so a capability for events alone cannot ask for a model", async () => {
    const capabilities = new CallbackCapabilities(secret);
    const source = capabilityModelGrants({ capabilities, holds: async () => true, describe: async () => ({ routes: [localRoute("anthropic", "claude-test").route] }) });
    const withAction = capabilities.issue({ workspaceId: "w", operationId: "o", fence: 3, actions: ["events", "model-access"], expiresInSeconds: 60 });
    const without = capabilities.issue({ workspaceId: "w", operationId: "o", fence: 3, actions: ["events", "result"], expiresInSeconds: 60 });
    await expect(source.grant(withAction)).resolves.toMatchObject({ workspaceId: "w", operationId: "o", fence: 3 });
    await expect(source.grant(without)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(source.grant(`${withAction}x`)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(source.grant("not-a-capability")).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("refuses an operation that lost its workspace, one with nothing described, and grants nothing before a task flow is wired", async () => {
    const capabilities = new CallbackCapabilities(secret);
    const token = capabilities.issue({ workspaceId: "w", operationId: "o", fence: 1, actions: ["model-access"], expiresInSeconds: 60 });
    const lost = capabilityModelGrants({ capabilities, holds: async () => false, describe: async () => ({ routes: [] }) });
    await expect(lost.grant(token)).rejects.toMatchObject({ code: "STALE_FENCE" });
    const none = capabilityModelGrants({ capabilities, holds: async () => true, describe: async () => undefined });
    await expect(none.grant(token)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(NO_MODEL_GRANTS.grant(token)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await NO_MODEL_GRANTS.active({ workspaceId: "w", operationId: "o", fence: 1 })).toBe(false);
    expect(await lost.active({ workspaceId: "w", operationId: "o", fence: undefined })).toBe(false);
  });
});

describe("the egress gateway's route table (the program the helper container runs)", () => {
  it("relays callbacks, the three model routes and the token request, and nothing else", async () => {
    const gateway = await loadGatewayRelay({ workspaceId: "ws-own", callbackPort: 1 });
    try {
      const route = (method: string, url: string) => gateway.library.callbackRoute(method, url, "ws-own");
      expect(route("POST", "/v1/internal/workspaces/ws-own/operations/op-1/events")).toEqual({ kind: "callback" });
      expect(route("POST", "/v1/internal/workspaces/ws-other/operations/op-1/events")).toMatchObject({ status: 403, reason: "other_workspace" });
      expect(route("GET", "/v1/internal/workspaces/ws-own/operations/op-1/events")).toMatchObject({ status: 405 });
      expect(route("GET", "/v1/internal/model-access")).toEqual({ kind: "model-access" });
      expect(route("GET", "/v1/internal/model-access?slot=reviewer-1")).toEqual({ kind: "model-access" });
      expect(route("POST", "/v1/internal/model-access")).toMatchObject({ status: 405 });
      for (const path of ["messages", "responses", "chat/completions"]) expect(route("POST", `/v1/internal/model-proxy/v1/${path}`), path).toEqual({ kind: "model-call" });
      expect(route("POST", "/v1/internal/model-proxy/v1/messages?beta=true")).toEqual({ kind: "model-call" });
      expect(route("GET", "/v1/internal/model-proxy/v1/messages")).toMatchObject({ status: 405 });
      for (const bad of ["/v1/internal/model-proxy/v1/models", "/v1/internal/model-proxy/v1/messages/batches", "/v1/internal/model-proxy/", "/v1/internal/model-proxy/v1/messages?x=1", "/v1/internal/model-access?slot=A", "/v1/internal/model-access/x", "/v1/internal/model-proxy/../model-access", "/v1/local/status", "/healthz", "/v1/admin/projects"]) {
        expect(route("POST", bad), bad).toMatchObject({ status: 404 });
        expect(route("GET", bad), bad).toHaveProperty("status");
      }
    } finally {
      await gateway.dispose();
    }
  });
});
