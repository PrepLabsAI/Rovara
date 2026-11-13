// Port lane P5 (item K2): the local model proxy calling providers that are `model-provider` plug-ins: another address and path, a named header, no sign-in, AWS SigV4 from a role,
// the Vertex variant of messages, stateless Responses, a provider that ignores forced tool choice, prices from the plug-in, and the guard rules that stay the same for every provider.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SecretValue, modelPriceRows, type Cost, type MeterEntry, type ModelProviderAdapter } from "@rovara-code/contracts";
import { modelNotEnabledBody } from "../../packages/model-runtime/src/index.js";
import { createPriceTableMetering } from "../../packages/core/src/ports/policy-defaults.js";
import {
  MODEL_PROXY_PREFIX, WORKSPACE_HEADER, builtinModelProviderBook, createLocalModelProxy, localRoute, type LocalModelProxy, type ModelProviderBook, type ProxyRoute,
} from "../../packages/core/src/local/model-proxy/index.js";
import { AWS_MODULE_MISSING, AwsCredentialSetupError, BUILTIN_MODEL_PROVIDERS, NATIVE_CHAT_CAPABILITIES, NATIVE_MESSAGES_CAPABILITIES, NATIVE_RESPONSES_CAPABILITIES, bedrockModelProvider } from "../../packages/core/src/plugins/model-provider/index.js";
import { fakeKey } from "../support/model-proxy-world.js";

const COMPANY = "org_00000000000000000000";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

interface Seen { path: string; headers: Record<string, string>; body: Record<string, unknown> }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

/** A provider that records the call and answers in the shape of the path it was called on. */
async function fakeUpstream(answer?: (seen: Seen, response: ServerResponse) => boolean) {
  const calls: Seen[] = [];
  const server = createServer((request, response) => void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const seen: Seen = { path: request.url ?? "", headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)])), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
    calls.push(seen);
    if (answer?.(seen, response) === true) return;
    response.writeHead(200, { "content-type": "application/json" });
    if (seen.path.includes("chat/completions")) response.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000, completion_tokens: 100 } }));
    else if (seen.path.includes("responses")) response.end(JSON.stringify({ output: [], usage: { input_tokens: 1_000, output_tokens: 100 } }));
    else response.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1_000, output_tokens: 100 } }));
  })());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, calls };
}

interface Answer { status: number; text: string; json: () => { error: { code: string; message: string } } }
interface World { proxy: LocalModelProxy; metered: MeterEntry[]; call: (route: ProxyRoute, body: Record<string, unknown>, options?: { budget?: Cost; operation?: string }) => Promise<Answer> }

async function world(options: { providers: ModelProviderAdapter[]; keys?: Record<string, string>; endpoints?: Record<string, string>; fetch?: typeof fetch }): Promise<World> {
  const rows = [...BUILTIN_MODEL_PROVIDERS, ...options.providers];
  const book: ModelProviderBook = { get: (id) => rows.find((row) => row.kind === id), ids: () => rows.map((row) => row.kind) };
  const priced = modelPriceRows(rows);
  const metered: MeterEntry[] = [];
  const keys = options.keys ?? {};
  const proxy = createLocalModelProxy({
    keys: { async get(_company, provider) { return keys[provider] === undefined ? undefined : new SecretValue(keys[provider]); }, async providers() { return Object.keys(keys); } },
    metering: createPriceTableMetering({ currency: priced.currency ?? "USD", models: priced.models }, (entry) => { metered.push(entry); }),
    companyId: COMPANY,
    providers: book,
    grants: { async grant() { throw new Error("not used"); }, async active() { return true; } },
    workerUrl: "http://rovara-broker:8081/v1/internal/model-proxy",
    ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const server = createServer((request, response) => void proxy.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as AddressInfo).port;
  let operations = 0;
  return {
    proxy, metered,
    async call(route, body, callOptions = {}) {
      operations += 1;
      const operationId = callOptions.operation ?? `aaaaaaaa-aaaa-4aaa-8aaa-${String(operations).padStart(12, "0")}`;
      const { token } = proxy.tokens.mint({ workspaceId: WORKSPACE, operationId, fence: 1, routes: [route], ...(callOptions.budget === undefined ? {} : { budget: callOptions.budget }) });
      const path = { "anthropic-messages": "/v1/messages", "openai-responses": "/v1/responses", "openai-completions": "/v1/chat/completions" }[route.api];
      const answer = await fetch(`http://127.0.0.1:${String(port)}${MODEL_PROXY_PREFIX}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, body: JSON.stringify({ ...body, model: route.alias }) });
      const text = await answer.text();
      return { status: answer.status, text, json: () => JSON.parse(text) as ReturnType<Answer["json"]> };
    },
  };
}

const chat = (over: Partial<ModelProviderAdapter> = {}): ModelProviderAdapter => ({
  kind: "company-gateway", name: "Company gateway", address: "https://models.example.test/v1", signIn: { kind: "bearer-key" },
  formats: [{ format: "openai-completions", pathOverride: "/chat/completions", capabilities: NATIVE_CHAT_CAPABILITIES }], ...over,
});
const userMessage = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 };

describe("a plug-in provider with its own address, path and key", () => {
  it("calls the provider's address and path override with the bearer key, under the provider's own model id, and prices the call from its table", async () => {
    const upstream = await fakeUpstream();
    const key = fakeKey("gw");
    const prices = { currency: "USD", models: { "house-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } };
    const { call, metered } = await world({ providers: [chat({ prices })], keys: { "company-gateway": key }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    const answer = await call(localRoute("company-gateway", "house-model", "openai-completions").route, userMessage);
    expect(answer.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.path).toBe("/v1/chat/completions");
    expect(upstream.calls[0]!.headers.authorization).toBe(`Bearer ${key}`);
    expect(upstream.calls[0]!.body.model).toBe("house-model");
    expect(answer.text).not.toContain(key);
    expect(metered).toHaveLength(1);
    expect(metered[0]!.usage).toMatchObject({ provider: "company-gateway", modelId: "house-model", tokens: { input: 1_000, output: 100 } });
  });

  it("holds a task budget against the provider's prices and stops the call that cannot fit", async () => {
    const upstream = await fakeUpstream();
    const prices = { currency: "USD", models: { "house-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } };
    const { call } = await world({ providers: [chat({ prices })], keys: { "company-gateway": fakeKey("gw") }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    const route = localRoute("company-gateway", "house-model", "openai-completions").route;
    const refused = await call(route, userMessage, { budget: { micros: 10, currency: "USD" } });
    expect(refused.status).toBe(422);
    expect(refused.json().error.code).toBe("budget_exceeded");
    expect(upstream.calls).toHaveLength(0);
    // A provider with no prices cannot hold a budget at all.
    const unpriced = await world({ providers: [chat()], keys: { "company-gateway": fakeKey("gw") }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    const noPrice = await unpriced.call(route, userMessage, { budget: { micros: 1_000_000, currency: "USD" } });
    expect(noPrice.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    // It is refused as "not priced" (its own error type), which the model runtime reads like a model the account may not use: the worker names it, and the broker learns it and leaves the model out next time.
    expect(noPrice.json().error).toMatchObject({ code: "model_not_priced", type: "model_not_priced" });
    expect(modelNotEnabledBody(noPrice.text)).toBe(true);
    // An ordinary refusal or a spent budget is not that.
    expect(modelNotEnabledBody(refused.text)).toBe(false);
    expect(modelNotEnabledBody(JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "model_not_allowed", message: "this task may not call that model, model_not_priced" } }))).toBe(false);
  });

  it("sends a key in the header the provider names", async () => {
    const upstream = await fakeUpstream();
    const key = fakeKey("az");
    const { call } = await world({ providers: [chat({ signIn: { kind: "named-header", header: "api-key" } })], keys: { "company-gateway": key }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    expect((await call(localRoute("company-gateway", "m", "openai-completions").route, userMessage)).status).toBe(200);
    expect(upstream.calls[0]!.headers["api-key"]).toBe(key);
    expect(upstream.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("needs no key for a provider with sign-in none, and sends none", async () => {
    const upstream = await fakeUpstream();
    const local = chat({ kind: "local-llm", address: upstream.url, signIn: { kind: "none" } });
    const { call } = await world({ providers: [local], keys: {}, endpoints: {} });
    expect((await call(localRoute("local-llm", "tiny", "openai-completions").route, userMessage)).status).toBe(200);
    expect(upstream.calls[0]!.headers.authorization).toBeUndefined();
    expect(upstream.calls[0]!.path).toBe("/chat/completions");
  });

  it("answers a fixed sentence for a provider that is not set up, a format it does not speak, and a missing key", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [chat()], keys: {}, endpoints: { "company-gateway": upstream.url } });
    expect((await call(localRoute("company-gateway", "m", "openai-completions").route, userMessage)).status).toBe(403);
    const unknown = await call(localRoute("nowhere", "m", "openai-completions").route, userMessage);
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain("not set up");
    const wrongFormat = await call({ ...localRoute("company-gateway", "m", "openai-completions").route, api: "anthropic-messages" }, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect([400, 403]).toContain(wrongFormat.status);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("the guard is the same for every provider", () => {
  it("refuses a provider-side tool, a fallback field, and a field the route does not allow, on a plug-in provider", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [chat()], keys: { "company-gateway": fakeKey("gw") }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    const route = localRoute("company-gateway", "m", "openai-completions").route;
    for (const extra of [{ tools: [{ type: "web_search" }] }, { fallbacks: ["x"] }, { api_key: "x" }, { tools: [{ type: "function", function: { name: "a" } }], tool_choice: { type: "web_search" } }]) {
      const refused = await call(route, { ...userMessage, ...extra });
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses a forced tool choice at a provider that ignores it, and lets 'auto' through", async () => {
    const upstream = await fakeUpstream();
    const ignoring = chat({ formats: [{ format: "openai-completions", pathOverride: "/chat/completions", capabilities: { ...NATIVE_CHAT_CAPABILITIES, forcedToolChoice: false } }] });
    const { call } = await world({ providers: [ignoring], keys: { "company-gateway": fakeKey("gw") }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    const route = localRoute("company-gateway", "m", "openai-completions").route;
    const tools = [{ type: "function", function: { name: "look", parameters: { type: "object" } } }];
    for (const choice of ["required", { type: "function", function: { name: "look" } }]) {
      const refused = await call(route, { ...userMessage, tools, tool_choice: choice });
      expect(refused.status).toBe(400);
      expect(refused.text).toContain("forced tool choice");
    }
    expect(upstream.calls).toHaveLength(0);
    expect((await call(route, { ...userMessage, tools, tool_choice: "auto" })).status).toBe(200);
  });
});

describe("Responses is stateless", () => {
  it("always sends store: false (Responses and chat completions), and refuses a stored-state field", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [], keys: { openai: fakeKey("sk-oai") }, endpoints: { openai: upstream.url } });
    const route = localRoute("openai", "gpt-test").route;
    expect((await call(route, { input: "hi", store: true })).status).toBe(200);
    expect(upstream.calls[0]!.body.store).toBe(false);
    expect((await call(route, { input: "hi" })).status).toBe(200);
    expect(upstream.calls[1]!.body.store).toBe(false);
    const stored = await call(route, { input: "hi", previous_response_id: "resp_1" });
    expect(stored.status).toBe(400);
    expect(upstream.calls).toHaveLength(2);
    // Chat completions is sent stateless too (review L5).
    const chatWorld = await world({ providers: [chat()], keys: { "company-gateway": fakeKey("gw") }, endpoints: { "company-gateway": `${upstream.url}/v1` } });
    await chatWorld.call(localRoute("company-gateway", "m", "openai-completions").route, { ...userMessage, store: true });
    expect(upstream.calls[2]!.body.store).toBe(false);
  });
});

describe("AWS sign-in from a role", () => {
  const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: ["wJalr", "never", "real", "secret"].join("-"), sessionToken: ["session", "never", "real", "token"].join("-") };

  it("signs a messages call with SigV4 on the provider's path, with no key header, and the worker's answer holds none of it", async () => {
    const upstream = await fakeUpstream();
    const bedrock = bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials });
    const { call, metered } = await world({ providers: [bedrock], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    const answer = await call(localRoute("amazon-bedrock", "anthropic.claude-test-v1:0", "anthropic-messages").route, { messages: [{ role: "user", content: "hi" }], max_tokens: 50, system: "s" });
    expect(answer.status).toBe(200);
    const seen = upstream.calls[0]!;
    expect(seen.path).toBe("/anthropic/v1/messages");
    expect(seen.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/u);
    expect(seen.headers["x-amz-security-token"]).toBe(credentials.sessionToken);
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.body.model).toBe("anthropic.claude-test-v1:0");
    expect(answer.text).not.toContain(credentials.secretAccessKey);
    expect(metered[0]!.usage.provider).toBe("amazon-bedrock");
  });

  it("refuses Claude's forced tool choice on Bedrock, because the plug-in says it is not honoured", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials })], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    const refused = await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5, tools: [{ name: "a", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "a" } });
    expect(refused.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it("takes the open-model route as chat completions on the same sign-in", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials })], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    expect((await call(localRoute("amazon-bedrock", "vendor.open-model", "openai-completions").route, userMessage)).status).toBe(200);
    expect(upstream.calls[0]!.path).toBe("/openai/v1/chat/completions");
    expect(upstream.calls[0]!.headers.authorization).toContain("AWS4-HMAC-SHA256");
  });

  it("stops an answer that holds the secret key, and does not repeat a failed sign-in's words", async () => {
    const leaking = await fakeUpstream((_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "message", content: [{ type: "text", text: `the secret is ${credentials.secretAccessKey}` }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return true;
    });
    const withRole = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials })], keys: {}, endpoints: { "amazon-bedrock": leaking.url } });
    const stopped = await withRole.call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(stopped.status).toBe(502);
    expect(stopped.text).not.toContain(credentials.secretAccessKey);

    const broken: ModelProviderAdapter = { ...bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials }), async credential() { throw new Error(`expired ${credentials.secretAccessKey}`); } };
    const failing = await world({ providers: [broken], keys: {}, endpoints: { "amazon-bedrock": leaking.url } });
    const refused = await failing.call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(refused.status).toBe(502);
    expect(refused.text).not.toContain(credentials.secretAccessKey);
    expect(refused.text).toContain("sign-in");
  });

  it("gives a worker no model access when there is no role and no key, and says what to fix", async () => {
    const noRole = bedrockModelProvider({ region: "us-west-2", credentials: async () => { throw new Error("no role"); } });
    const route = localRoute("amazon-bedrock", "m", "anthropic-messages").route;
    const grants = { workspaceId: WORKSPACE, operationId: "op", fence: 1, routes: [route] };
    const held = createLocalModelProxy({
      keys: { async get() { return undefined; }, async providers() { return []; } }, metering: createPriceTableMetering({ currency: "USD", models: {} }), companyId: COMPANY,
      providers: { get: (id) => (id === "amazon-bedrock" ? noRole : undefined), ids: () => ["amazon-bedrock"] },
      grants: { async grant() { return grants; }, async active() { return true; } }, workerUrl: "http://rovara-broker:8081/v1/internal/model-proxy",
    });
    const access = await held.access({ path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": "c".repeat(48), [WORKSPACE_HEADER]: WORKSPACE } });
    expect(access.statusCode).toBe(403);
    expect(access.body).toContain("sign-in");
    expect(access.body).toContain("AWS");
  });
});

describe("Claude on Google Cloud (the vertex variant of messages)", () => {
  const vertex: ModelProviderAdapter = {
    kind: "vertex-claude", name: "Claude on Google Cloud", address: "https://models.example.test/v1/projects/p/locations/us-east5/publishers/anthropic/models", signIn: { kind: "google-oauth" },
    formats: [{ format: "anthropic-messages", variant: "vertex", capabilities: NATIVE_MESSAGES_CAPABILITIES }],
    async credential() { return new SecretValue("ya29.token-never-real-0123456789"); },
  };

  it("puts the model in the address, takes it out of the body, adds the version, and signs with the access token", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [vertex], keys: {}, endpoints: { "vertex-claude": `${upstream.url}/v1/projects/p/locations/us-east5/publishers/anthropic/models` } });
    const route = localRoute("vertex-claude", "claude-test@20250101", "anthropic-messages").route;
    expect((await call(route, { messages: [{ role: "user", content: "hi" }], max_tokens: 50 })).status).toBe(200);
    const seen = upstream.calls[0]!;
    expect(seen.path).toBe("/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-test%4020250101:rawPredict");
    expect(seen.body.model).toBeUndefined();
    expect(seen.body.anthropic_version).toBe("vertex-2023-10-16");
    expect(seen.headers.authorization).toBe("Bearer ya29.token-never-real-0123456789");
    expect(seen.headers["anthropic-version"]).toBeUndefined();
    expect((await call(route, { messages: [{ role: "user", content: "hi" }], max_tokens: 50, stream: true })).status).toBe(200);
    expect(upstream.calls[1]!.path.endsWith(":streamRawPredict")).toBe(true);
  });

  it("still refuses a provider-side tool", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [vertex], keys: {}, endpoints: { "vertex-claude": upstream.url } });
    const refused = await call(localRoute("vertex-claude", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5, tools: [{ type: "web_search_20250305", name: "web_search" }] });
    expect(refused.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("the built-in providers are unchanged", () => {
  it("still call Anthropic with x-api-key and a version, and OpenRouter with a bearer key", async () => {
    const upstream = await fakeUpstream();
    const anthropicKey = fakeKey("sk-ant"), routerKey = fakeKey("sk-or");
    const { call } = await world({ providers: [], keys: { anthropic: anthropicKey, openrouter: routerKey }, endpoints: { anthropic: upstream.url, openrouter: upstream.url } });
    await call(localRoute("anthropic", "claude-test").route, { messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    expect(upstream.calls[0]!.headers["x-api-key"]).toBe(anthropicKey);
    expect(upstream.calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(upstream.calls[0]!.headers.authorization).toBeUndefined();
    await call(localRoute("openrouter", "vendor/m").route, userMessage);
    expect(upstream.calls[1]!.headers.authorization).toBe(`Bearer ${routerKey}`);
    expect(upstream.calls[1]!.path).toBe("/v1/chat/completions");
    expect(builtinModelProviderBook().ids()).toEqual(["anthropic", "openai", "openrouter"]);
    expect(NATIVE_RESPONSES_CAPABILITIES.reasoning).toBe("effort");
  });
});

describe("which credential wins (review M2)", () => {
  const ambient = { accessKeyId: "AKIAAMBIENT", secretAccessKey: ["ambient", "never", "real"].join("-") };
  const explicit = { accessKeyId: "AKIAEXPLICIT", secretAccessKey: ["explicit", "never", "real"].join("-") };

  it("uses the amazon-bedrock entry of the key file before the provider's own session", async () => {
    const upstream = await fakeUpstream();
    let sessionAsked = 0;
    const bedrock = bedrockModelProvider({ region: "us-west-2", credentials: async () => { sessionAsked += 1; return ambient; } });
    const { call } = await world({ providers: [bedrock], keys: { "amazon-bedrock": JSON.stringify(explicit) }, endpoints: { "amazon-bedrock": upstream.url } });
    expect((await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 })).status).toBe(200);
    expect(upstream.calls[0]!.headers.authorization).toContain("Credential=AKIAEXPLICIT/");
    expect(sessionAsked).toBe(0);
  });

  it("falls back to the provider's own session when the key file has no entry", async () => {
    const upstream = await fakeUpstream();
    const bedrock = bedrockModelProvider({ region: "us-west-2", credentials: async () => ambient });
    const { call } = await world({ providers: [bedrock], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(upstream.calls[0]!.headers.authorization).toContain("Credential=AKIAAMBIENT/");
  });

  it("holds for any provider with a credential(): the stored token wins over the refreshed one", async () => {
    const upstream = await fakeUpstream();
    const vertex: ModelProviderAdapter = {
      kind: "vertex-claude", name: "Claude on Google Cloud", address: "https://models.example.test/models", signIn: { kind: "google-oauth" },
      formats: [{ format: "anthropic-messages", variant: "vertex", capabilities: NATIVE_MESSAGES_CAPABILITIES }],
      credential: async () => new SecretValue("ya29.refreshed-never-real-0123456789"),
    };
    const { call } = await world({ providers: [vertex], keys: { "vertex-claude": "ya29.stored-never-real-0123456789" }, endpoints: { "vertex-claude": `${upstream.url}/models` } });
    await call(localRoute("vertex-claude", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(upstream.calls[0]!.headers.authorization).toBe("Bearer ya29.stored-never-real-0123456789");
  });
});

describe("the words for a failed sign-in and a skewed clock (review L2, info)", () => {
  it("names a missing AWS module in the refusal, and the access answer, and never the SDK's words", async () => {
    const upstream = await fakeUpstream();
    const bedrock = bedrockModelProvider({ region: "us-west-2", identity: { kind: "ambient" }, loaders: {
      async profile() { throw new Error("n/a"); }, async role() { throw new Error("n/a"); },
      async ambient() { throw new AwsCredentialSetupError(AWS_MODULE_MISSING); },
    } });
    const { call } = await world({ providers: [bedrock], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    const refused = await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("AWS credential module missing");
    expect(upstream.calls).toHaveLength(0);
  });

  it("tells the owner to check the computer's clock when AWS says the signature is expired or too skewed, and does not repeat the key", async () => {
    const skewed = await fakeUpstream((_seen, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Signature expired: 20261110T000000Z is now earlier than 20261110T001000Z (20261110T001500Z - 5 min.)" }));
      return true;
    });
    const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: ["wJalr", "never", "real"].join("-") };
    const { call } = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials })], keys: {}, endpoints: { "amazon-bedrock": skewed.url } });
    const refused = await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 });
    expect(refused.status).toBe(502);
    expect(refused.json().error.code).toBe("provider_clock_skew");
    expect(refused.text).toContain("check your computer's clock");
    // Any other 403 is still "refused the key".
    const denied = await fakeUpstream((_seen, response) => { response.writeHead(403, { "content-type": "application/json" }); response.end(JSON.stringify({ message: "not authorized" })); return true; });
    const other = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => credentials })], keys: {}, endpoints: { "amazon-bedrock": denied.url } });
    expect((await other.call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 })).json().error.code).toBe("provider_refused_key");
  });

  it("holds a Bedrock model with no price out of a budget-held task, as for any unpriced model", async () => {
    const upstream = await fakeUpstream();
    const { call } = await world({ providers: [bedrockModelProvider({ region: "us-west-2", credentials: async () => ({ accessKeyId: "A", secretAccessKey: "S" }) })], keys: {}, endpoints: { "amazon-bedrock": upstream.url } });
    const refused = await call(localRoute("amazon-bedrock", "m", "anthropic-messages").route, { messages: [{ role: "user", content: "x" }], max_tokens: 5 }, { budget: { micros: 1_000_000, currency: "USD" } });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("no price");
    expect(refused.json().error.code).toBe("model_not_priced");
    expect(upstream.calls).toHaveLength(0);
  });
});
