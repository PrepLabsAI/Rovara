// Port lane L9a, K1: a world to test the local model proxy in: a fake provider on a real socket, the real callback listener serving the real
// proxy, a key store, a price table, callback capabilities, and (optionally) the egress gateway's own relay program loaded as a library.
// Nothing here is a real key: key-shaped strings are built at run time.
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, agentXError, type Cost, type MeterEntry, type MeterResult, type ModelKeyStore, type PriceTable } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";
import { startCallbackServer, type CallbackServer } from "../../packages/broker/src/local/callback-server.js";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/broker/src/local/isolation/egress-gateway-source.js";
import {
  CAPABILITY_HEADER, WORKSPACE_HEADER, capabilityModelGrants, createLocalModelProxy, localRoute,
  type LocalModelProxy, type ModelProxyEvent, type ProxyRoute,
} from "../../packages/broker/src/local/model-proxy/index.js";

export const COMPANY = "org_00000000000000000000";
export const WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
export const OPERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_OPERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A key-shaped string built at run time (GitHub push protection refuses key-shaped literals). */
export const fakeKey = (prefix: string): string => `${prefix}-${["test", "never", "real"].join("")}-${randomBytes(9).toString("hex")}`;

export const PRICES: PriceTable = {
  currency: "USD",
  models: {
    "anthropic/claude-test": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 3_750_000 },
    "openai/gpt-test": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 },
    "openrouter/vendor/model-test": { inputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 1_500_000 },
  },
};

export interface ProviderCall { provider: "anthropic" | "openai" | "openrouter"; path: string; headers: Record<string, string>; body: Record<string, unknown> }
export type ProviderMode = "ok" | "split-key-in-stream" | "flood" | "cut" | "unauthorized-echo" | "rate-limit" | "echo-key-in-stream" | "echo-key-whole" | "redirect" | "server-error" | "no-usage" | "slow";

/** One fake server standing in for the three providers (they differ by path). It records what it was sent. */
export async function startFakeProvider(): Promise<{ url: string; calls: ProviderCall[]; mode: ProviderMode; aborted: number; close(): Promise<void> }> {
  const state = { calls: [] as ProviderCall[], mode: "ok" as ProviderMode, aborted: 0 };
  const server = createServer((request, response) => void answer(request, response));
  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));
    const path = request.url ?? "";
    const provider = path === "/v1/messages" ? "anthropic" : path === "/v1/responses" ? "openai" : "openrouter";
    state.calls.push({ provider, path, headers, body });
    const key = (headers["x-api-key"] ?? headers.authorization?.replace(/^Bearer /u, "")) ?? "";
    response.on("close", () => { if (!response.writableEnded) state.aborted += 1; });
    const json = (status: number, value: unknown, extra: Record<string, string> = {}): void => { response.writeHead(status, { "content-type": "application/json", ...extra }); response.end(JSON.stringify(value)); };
    switch (state.mode) {
      case "unauthorized-echo": return json(401, { error: { message: `Incorrect API key provided: ${key}. You can find your API key at the dashboard.`, type: "invalid_request_error" } });
      case "rate-limit": return json(429, { error: { message: "slow down" } }, { "retry-after": "7", "x-secret-header": key });
      case "server-error": return json(503, { error: { message: `overloaded ${key.slice(0, 16)} and ${key.slice(-10)}` } });
      case "redirect": response.writeHead(307, { location: `http://127.0.0.1:1/followed?k=${key}` }); return void response.end();
      default:
    }
    if (state.mode === "split-key-in-stream") {
      // The key arrives in two network chunks, with a pause between them.
      response.writeHead(200, { "content-type": "text/event-stream" });
      const line = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `the key is ${key} ok` } })}\n\n`;
      const cut = line.indexOf(key) + Math.floor(key.length / 2);
      response.write(line.slice(0, cut));
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.write(line.slice(cut));
      return void response.end();
    }
    if (state.mode === "cut") {
      // The provider's connection dies in the middle of the answer.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1_000, output_tokens: 1 } } })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return void response.destroy();
    }
    if (state.mode === "flood") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const filler = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(60_000) } })}\n\n`;
      for (let index = 0; index < 600 && !response.destroyed; index += 1) {
        if (!response.write(filler)) {
          await new Promise<void>((resolve) => {
            const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
            response.once("drain", done);
            response.once("close", done);
          });
        }
      }
      return void response.end();
    }
    const stream = body.stream === true;
    const text = state.mode === "echo-key-in-stream" || state.mode === "echo-key-whole" ? `here is the key ${key}` : "hello";
    const usage = state.mode === "no-usage";
    if (provider === "anthropic") {
      if (!stream) return json(200, { type: "message", content: [{ type: "text", text }], ...(usage ? {} : { usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 400 } }) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (name: string, data: unknown): void => void response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 1_000, output_tokens: 1, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 400 } } });
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      if (state.mode === "slow") await new Promise((resolve) => setTimeout(resolve, 400));
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } });
      event("message_stop", { type: "message_stop" });
      return void response.end();
    }
    if (provider === "openai") {
      if (!stream) return json(200, { id: "r", output: [{ type: "message", content: [{ type: "output_text", text }] }], ...(usage ? {} : { usage: { input_tokens: 2_000, output_tokens: 300, input_tokens_details: { cached_tokens: 500 } } }) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
      if (state.mode === "slow") await new Promise((resolve) => setTimeout(resolve, 400));
      response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 2_000, output_tokens: 300, input_tokens_details: { cached_tokens: 500 } } } })}\n\n`);
      return void response.end();
    }
    if (!stream) return json(200, { id: "c", choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: { prompt_tokens: 4_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1_000 } } });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    if (state.mode === "slow") await new Promise((resolve) => setTimeout(resolve, 400));
    response.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? {} : { usage: { prompt_tokens: 4_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1_000 } } }) })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, calls: state.calls,
    get mode() { return state.mode; }, set mode(value: ProviderMode) { state.mode = value; },
    get aborted() { return state.aborted; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

export interface ModelProxyWorld {
  provider: Awaited<ReturnType<typeof startFakeProvider>>;
  proxy: LocalModelProxy;
  callback: CallbackServer;
  keys: Record<"anthropic" | "openai" | "openrouter", string>;
  events: ModelProxyEvent[];
  metered: Array<{ entry: MeterEntry; result: MeterResult }>;
  routes: { anthropic: ProxyRoute; openai: ProxyRoute; openrouter: ProxyRoute };
  /** A capability for an operation (signed with the world's secret); `actions` default to model access. */
  capability(operation?: { workspaceId?: string; operationId?: string; fence?: number; actions?: string[]; expiresInSeconds?: number }): string;
  /** The operations that still hold their workspace; remove one to end it. */
  active: Set<string>;
  /** Budgets by operation id (absent: none). */
  budgets: Map<string, Cost>;
  /** Switch on to make the meter fail when a call is recorded. */
  meterFault: { on: boolean };
  /** Switched on, the meter answers every call with no cost (a model nobody priced). */
  meterNoCost: { on: boolean };
  /** Switched on, the model has no price at all: the proxy cannot price a call before it is made (the reservation) or after it (the record). */
  meterUnpriced: { on: boolean };
  /** Design-review key slots by `<operation>:<slot>` (a slot absent here is not served): the slot's budget in micros. */
  slots: Map<string, number>;
  /** Slots (by `<operation>:<slot>`) whose model counts as unpriced and is bounded by an assumed price (the dearest public class). */
  assumedSlots: Set<string>;
  /** The slot tokens that were minted, as the grant source recorded them (ids only). */
  mintedSlots: Array<{ slot: string; keyId: string; expiresAt: number }>;
  /** The models an operation may call (default: all three). */
  allowed: Map<string, ProxyRoute[]>;
  /** The key store as the proxy sees it: remove a provider to have none. */
  keyStore: ModelKeyStore & { remove(provider: string): void; failWith(error: Error | undefined): void };
  /** Calls the callback listener the way the egress gateway's relay does (the owner's side of the wire). */
  send(options: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: unknown; raw?: string }): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  /** Everything the world ever put on a wire or in a log, for "the key is not here" checks. */
  close(): Promise<void>;
  directory: string;
}

export async function startModelProxyWorld(options: { ttlSeconds?: number; now?: () => number; fetch?: typeof fetch; maxConcurrentPerOperation?: number; keyDelayMs?: number; requestTimeoutMs?: number; keySource?: string } = {}): Promise<ModelProxyWorld> {
  const provider = await startFakeProvider();
  const directory = await mkdtemp(join(tmpdir(), "model-proxy-"));
  const keys = { anthropic: fakeKey("sk-ant"), openai: fakeKey("sk-oai"), openrouter: fakeKey("sk-or") };
  const present = new Map<string, string>(Object.entries(keys));
  let failure: Error | undefined;
  const keyStore: ModelKeyStore & { remove(provider: string): void; failWith(error: Error | undefined): void } = {
    async get(_company, name) { if (failure !== undefined) throw failure; if (options.keyDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.keyDelayMs)); const value = present.get(name); return value === undefined ? undefined : new SecretValue(value); },
    async providers() { return [...present.keys()]; },
    remove(name) { present.delete(name); },
    failWith(error) { failure = error; },
  };
  const metered: ModelProxyWorld["metered"] = [];
  const priced = createPriceTableMetering(PRICES, (entry, result) => { metered.push({ entry, result }); });
  const meterFault = { on: false };
  const meterNoCost = { on: false };
  const meterUnpriced = { on: false };
  /** The meter, with a fault a test can switch on: recording a call then fails, as a failing store would. */
  const metering: typeof priced = { ...priced, async price(usage) { return meterUnpriced.on ? null : priced.price(usage); }, async record(entry) { if (meterFault.on) throw new Error("the meter is down"); const result = await priced.record(entry); return meterNoCost.on || meterUnpriced.on ? { ...result, cost: null } : result; } };
  const secret = randomBytes(32);
  const capabilities = new CallbackCapabilities(secret);
  const routes = { anthropic: localRoute("anthropic", "claude-test").route, openai: localRoute("openai", "gpt-test").route, openrouter: localRoute("openrouter", "vendor/model-test").route };
  const active = new Set<string>([`${WORKSPACE}:${OPERATION}:1`]);
  const budgets = new Map<string, Cost>();
  const allowed = new Map<string, ProxyRoute[]>();
  const slots = new Map<string, number>();
  const assumedSlots = new Set<string>();
  const mintedSlots: Array<{ slot: string; keyId: string; expiresAt: number }> = [];
  const events: ModelProxyEvent[] = [];
  const proxy = createLocalModelProxy({
    keys: keyStore, metering, companyId: COMPANY,
    ...(options.keySource === undefined ? {} : { keySource: options.keySource }),
    workerUrl: "http://rovara-broker:8081/v1/internal/model-proxy",
    endpoints: { anthropic: provider.url, openai: provider.url, openrouter: provider.url },
    grants: capabilityModelGrants({
      capabilities,
      holds: async (operation) => active.has(`${operation.workspaceId}:${operation.operationId}:${String(operation.fence)}`),
      describeSlot: async (operation, slot) => {
        const ceiling = slots.get(`${operation.operationId}:${slot}`);
        if (ceiling === undefined) return undefined;
        if (mintedSlots.some((entry) => entry.slot === slot)) throw agentXError("FORBIDDEN", "asked again");
        return { routes: [routes.anthropic], budget: { micros: ceiling, currency: "USD" }, taskId: "task-1", projectName: "demo", ...(assumedSlots.has(`${operation.operationId}:${slot}`) ? { assumedPrice: { inputMicrosPerMillionTokens: 15_000_000, outputMicrosPerMillionTokens: 75_000_000 } } : {}) };
      },
      slotMinted: async (_operation, slot, minted) => { mintedSlots.push({ slot, ...minted }); },
      describe: async (operation) => ({
        routes: allowed.get(operation.operationId) ?? [routes.anthropic, routes.openai, routes.openrouter],
        ...(budgets.has(operation.operationId) ? { budget: budgets.get(operation.operationId)! } : {}),
        taskId: "task-1", projectName: "demo",
      }),
    }),
    onEvent: (event) => events.push(event),
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxConcurrentPerOperation === undefined ? {} : { maxConcurrentPerOperation: options.maxConcurrentPerOperation }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const callback = await startCallbackServer({ handler: async () => ({ statusCode: 404, headers: {}, body: "{}" }), stateDirectory: directory, unixSocket: false, modelProxy: proxy });
  const send: ModelProxyWorld["send"] = (request) => new Promise((resolve, reject) => {
    const body = request.raw ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
    // The egress gateway stamps the workspace on every call; a test that wants none says `[WORKSPACE_HEADER]: undefined`.
    const headers: Record<string, string> = { host: `host.docker.internal:${callback.tcpPort}`, ...(request.headers !== undefined && WORKSPACE_HEADER in request.headers ? {} : { [WORKSPACE_HEADER]: WORKSPACE }) };
    for (const [name, value] of Object.entries(request.headers ?? {})) if (value !== undefined) headers[name] = value;
    if (body !== undefined) headers["content-type"] = "application/json";
    const outgoing = httpRequest({ host: "127.0.0.1", port: callback.tcpPort, method: request.method ?? "POST", path: request.path, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, String(value)])), text: Buffer.concat(chunks).toString("utf8") }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  return {
    provider, proxy, callback, keys, events, metered, routes, active, budgets, allowed, slots, assumedSlots, mintedSlots, meterFault, meterNoCost, meterUnpriced, keyStore, send, directory,
    capability: (operation = {}) => capabilities.issue({
      workspaceId: operation.workspaceId ?? WORKSPACE, operationId: operation.operationId ?? OPERATION, fence: operation.fence ?? 1,
      actions: (operation.actions ?? ["model-access"]) as Parameters<CallbackCapabilities["issue"]>[0]["actions"], expiresInSeconds: operation.expiresInSeconds ?? 3_600,
    }),
    async close() {
      await callback.close();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Asks for a token the way the worker does, and returns it (or the refusal). */
export async function askForToken(world: ModelProxyWorld, capability: string, workspaceHeader?: string): Promise<{ status: number; token?: string; expiresAt?: number; text: string }> {
  const answer = await world.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: capability, ...(workspaceHeader === undefined ? {} : { [WORKSPACE_HEADER]: workspaceHeader }) } });
  if (answer.status !== 200) return { status: answer.status, text: answer.text };
  const parsed = JSON.parse(answer.text) as { apiKey: string; expiresAt: number };
  return { status: 200, token: parsed.apiKey, expiresAt: parsed.expiresAt, text: answer.text };
}

// ---- the egress gateway's relay, the program the helper container runs, loaded as a library

export interface GatewayLibrary {
  callbackRoute(method: string, url: string, workspaceId: string): { kind?: string; status?: number; reason?: string };
  startCallbackRelay(ip: string): Server;
}

export async function loadGatewayRelay(config: { workspaceId: string; callbackPort: number; relayPort?: number }): Promise<{ library: GatewayLibrary; relay: Server; url: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-"));
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = process.env.ROVARA_GW_CONFIG;
  const savedLibrary = process.env.ROVARA_GW_LIBRARY;
  process.env.ROVARA_GW_LIBRARY = "1";
  process.env.ROVARA_GW_CONFIG = JSON.stringify({
    nets: { worker: "127.0.0.0/8", sandbox: "10.0.0.0/8", external: "10.0.0.0/8" },
    callback: { workspaceId: config.workspaceId, hostHeader: `host.docker.internal:${config.callbackPort}`, port: config.relayPort ?? 0, targets: [{ host: "127.0.0.1", port: config.callbackPort }] },
  });
  let library: GatewayLibrary;
  try {
    library = createRequire(import.meta.url)(file) as GatewayLibrary;
  } finally {
    if (saved === undefined) delete process.env.ROVARA_GW_CONFIG; else process.env.ROVARA_GW_CONFIG = saved;
    if (savedLibrary === undefined) delete process.env.ROVARA_GW_LIBRARY; else process.env.ROVARA_GW_LIBRARY = savedLibrary;
  }
  const relay = library.startCallbackRelay("127.0.0.1");
  await new Promise<void>((resolve) => relay.once("listening", () => resolve()));
  return {
    library, relay, url: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    async dispose() {
      await new Promise<void>((resolve) => { relay.close(() => resolve()); relay.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
