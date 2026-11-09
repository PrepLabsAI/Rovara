// Port lane L9a, K1: the local model proxy end to end on real sockets: a fake provider, the real callback listener serving the real proxy, the egress
// gateway's own relay program in front of it, and the worker's own model-access client and model library calling it. The worker never sees a key.
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { Context } from "@earendil-works/pi-ai";
import { ROUTE_PROVIDER, createModelRuntimeWithFallback } from "../../packages/model-runtime/src/index.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { CAPABILITY_HEADER, MODEL_PROXY_PREFIX, WORKSPACE_HEADER, localRoute } from "../../packages/broker/src/local/model-proxy/index.js";
import {
  OPERATION, OTHER_OPERATION, OTHER_WORKSPACE, WORKSPACE, askForToken, loadGatewayRelay, startModelProxyWorld, type ModelProxyWorld,
} from "../support/model-proxy-world.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });
async function world(options: Parameters<typeof startModelProxyWorld>[0] = {}): Promise<ModelProxyWorld> {
  const made = await startModelProxyWorld(options);
  open.push(() => made.close());
  return made;
}

const MESSAGES = `${MODEL_PROXY_PREFIX}/v1/messages`;
const RESPONSES = `${MODEL_PROXY_PREFIX}/v1/responses`;
const CHAT = `${MODEL_PROXY_PREFIX}/v1/chat/completions`;
const asWorker = (token: string | undefined, extra: Record<string, string> = {}) => ({ ...(token === undefined ? {} : { "x-api-key": token }), [WORKSPACE_HEADER]: WORKSPACE, "anthropic-version": "2023-06-01", ...extra });
const anthropicBody = (over: Record<string, unknown> = {}) => ({ model: "anthropic/claude-test", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }], ...over });

async function tokenOf(w: ModelProxyWorld, operation = {}): Promise<string> {
  const answer = await askForToken(w, w.capability(operation));
  expect(answer.status, answer.text).toBe(200);
  return answer.token!;
}

const errorOf = (answer: { text: string }): { code: string; type?: string; message: string } => (JSON.parse(answer.text) as { error: { code: string; type?: string; message: string } }).error;
const apiKeyOf = (answer: { text: string }): string => (JSON.parse(answer.text) as { apiKey: string }).apiKey;

/** Everything a worker, a log or a ledger could show, so "the key is not here" is checked in one place. */
function everythingVisible(w: ModelProxyWorld, ...answers: Array<{ text: string; headers?: Record<string, string> }>): string {
  return JSON.stringify([w.events, w.metered, answers, [...w.provider.calls.map((call) => call.body)]]);
}

describe("asking for model access", () => {
  it("hands a worker a short-lived token and the proxy's address, and not a key", async () => {
    const w = await world();
    const answer = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability() } });
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.text) as { baseUrl: string; apiKey: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["apiKey", "baseUrl", "expiresAt"]);
    expect(body.baseUrl).toBe("http://rovara-broker:8081/v1/internal/model-proxy");
    expect(body.apiKey).toMatch(/^rvm_[A-Za-z0-9_-]{40,}$/u);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
    for (const key of Object.values(w.keys)) expect(answer.text).not.toContain(key);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(w.events)).not.toContain(body.apiKey);
  });

  it("refuses a capability that is missing, forged, expired, for another action, or for an operation that lost its workspace", async () => {
    const w = await world();
    const refusals: Array<[string, string | undefined, number]> = [
      ["none", undefined, 403],
      ["short", "abc", 403],
      ["forged", `${w.capability()}x`, 403],
      ["events only", w.capability({ actions: ["events", "result"] }), 403],
      ["expired", w.capability({ expiresInSeconds: -5 }), 403],
      ["lost its workspace", w.capability({ fence: 9 }), 409],
      ["unknown operation", w.capability({ operationId: OTHER_OPERATION }), 409],
    ];
    for (const [what, capability, status] of refusals) {
      const answer = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: capability === undefined ? {} : { [CAPABILITY_HEADER]: capability } });
      expect(answer.status, what).toBe(status);
      expect(answer.text, what).not.toMatch(/rvm_/u);
    }
    expect(w.proxy.tokens.liveTokens()).toBe(0);
  });

  it("says in words what to do when no key is set for the task's models, and quotes nothing", async () => {
    const w = await world();
    for (const provider of ["anthropic", "openai", "openrouter"]) w.keyStore.remove(provider);
    const answer = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability() } });
    expect(answer.status).toBe(403);
    const error = (JSON.parse(answer.text) as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("MODEL_NOT_ALLOWED");
    expect(error.message).toMatch(/no anthropic or openai or openrouter key is set on this computer/u);
  });

  it("serves a task that has a key for at least one of its models, and refuses a design-review slot it does not serve yet", async () => {
    const w = await world();
    w.keyStore.remove("openai");
    w.keyStore.remove("openrouter");
    expect((await askForToken(w, w.capability())).status).toBe(200);
    const slot = await w.send({ method: "GET", path: "/v1/internal/model-access?slot=reviewer-1", headers: { [CAPABILITY_HEADER]: w.capability() } });
    expect(slot.status).toBe(403);
    expect(slot.text).toContain("MODEL_NOT_ALLOWED");
  });

  it("refuses when the task's budget is already spent, in the words the worker reads as the task's budget", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 5_000, currency: "USD" });
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    const again = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability() } });
    expect(again.status).toBe(402);
    expect(again.text).toContain("BUDGET_EXCEEDED");
    expect(again.text).toContain("This task has used its AI budget");
  });
});

describe("a model call through the proxy", () => {
  it("forwards a streamed Anthropic call with the real key, a model name the provider knows, and nothing else the worker sent", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const answer = await w.send({
      path: MESSAGES, headers: asWorker(token, { cookie: "session=1", "x-forwarded-for": "10.0.0.1", "x-custom": "yes", "anthropic-beta": "interleaved-thinking-2025-05-14", "user-agent": "worker-client" }),
      body: anthropicBody({ thinking: { type: "enabled", budget_tokens: 1024 } }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("text/event-stream");
    expect(answer.text).toContain("message_start");
    expect(answer.text).toContain("hello");
    const call = w.provider.calls[0]!;
    expect(call.path).toBe("/v1/messages");
    expect(call.headers["x-api-key"]).toBe(w.keys.anthropic);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(call.headers["user-agent"]).toBe("rovara-local-model-proxy");
    for (const dropped of ["cookie", "x-forwarded-for", "x-custom", WORKSPACE_HEADER]) expect(call.headers[dropped], dropped).toBeUndefined();
    expect(call.body.model).toBe("claude-test");
    expect(call.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(JSON.stringify(call)).not.toContain(token);
    expect(everythingVisible(w, answer)).not.toContain(w.keys.anthropic);
  });

  it("meters each call through the metering port at its model's price, under the task", async () => {
    const w = await world();
    const token = await tokenOf(w);
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(w.metered).toHaveLength(1);
    const { entry, result } = w.metered[0]!;
    expect(entry).toMatchObject({ companyId: "org_00000000000000000000", taskId: "task-1", projectName: "demo", usage: { provider: "anthropic", modelId: "claude-test", tokens: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 400 } } });
    expect(entry.entryId.startsWith(`${OPERATION}:`)).toBe(true);
    expect(result.cost).toEqual({ micros: 9_000, currency: "USD" });
    expect(w.proxy.tokens.ledger(OPERATION)).toMatchObject({ spentMicros: 9_000, unpriced: 0, inFlight: 0, currency: "USD" });
  });

  it("serves OpenAI (Bearer, responses) and OpenRouter (chat, usage turned on) with their own keys and prices", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const openai = await w.send({ path: RESPONSES, headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, body: { model: "openai/gpt-test", input: [{ role: "user", content: "hi" }], stream: false } });
    expect(openai.status).toBe(200);
    expect(w.provider.calls[0]).toMatchObject({ path: "/v1/responses", body: { model: "gpt-test" } });
    expect(w.provider.calls[0]!.headers.authorization).toBe(`Bearer ${w.keys.openai}`);
    const router = await w.send({ path: CHAT, headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, body: { model: "openrouter/vendor/model-test", messages: [{ role: "user", content: "hi" }], stream: true } });
    expect(router.status).toBe(200);
    expect(w.provider.calls[1]).toMatchObject({ path: "/v1/chat/completions", body: { model: "vendor/model-test", stream_options: { include_usage: true } } });
    expect(w.provider.calls[1]!.headers.authorization).toBe(`Bearer ${w.keys.openrouter}`);
    expect(w.metered.map((item) => [item.entry.usage.provider, item.result.cost?.micros])).toEqual([["openai", 3_200], ["openrouter", 2_150]]);
    expect(everythingVisible(w, openai, router)).not.toMatch(new RegExp(Object.values(w.keys).join("|"), "u"));
  });

  it("meters a call that was not streamed", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false }) });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toMatchObject({ type: "message" });
    expect(w.metered[0]!.result.cost?.micros).toBe(9_000);
  });

  it("records nothing, and says so, when the provider reported no usage", async () => {
    const w = await world();
    w.provider.mode = "no-usage";
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false }) })).status).toBe(200);
    expect(w.metered).toHaveLength(0);
    expect(w.events.some((event) => event.event === "unmetered" && event.code === "no_usage_reported")).toBe(true);
  });
});

describe("who may call", () => {
  it("refuses a call with no token, a wrong token, two different tokens, or a token in the wrong place", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const calls: Array<[string, Record<string, string>]> = [
      ["no token", asWorker(undefined)],
      ["wrong token", asWorker("rvm_" + "A".repeat(43))],
      ["a model key as the token", asWorker(w.keys.anthropic)],
      ["two tokens that differ", asWorker(token, { authorization: "Bearer rvm_other" })],
      ["a capability as the token", asWorker(w.capability())],
      ["an enormous token", asWorker("x".repeat(300))],
    ];
    for (const [what, headers] of calls) {
      const answer = await w.send({ path: MESSAGES, headers, body: anthropicBody() });
      expect(answer.status, what).toBe(401);
    }
    expect(w.provider.calls).toHaveLength(0);
  });

  it("refuses a token after it expires, with words that tell the worker to ask again", async () => {
    let now = Date.now();
    const w = await world({ now: () => now, ttlSeconds: 200 });
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    now += 201_000;
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(answer.status).toBe(401);
    expect(errorOf(answer)).toMatchObject({ code: "token_expired" });
    expect(w.provider.calls).toHaveLength(1);
  });

  it("refuses another workspace's worker using the token, and a call with no workspace stamp", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const stolen = await w.send({ path: MESSAGES, headers: { ...asWorker(token), [WORKSPACE_HEADER]: OTHER_WORKSPACE }, body: anthropicBody() });
    expect(stolen.status).toBe(403);
    expect(errorOf(stolen).code).toBe("other_workspace");
    const bare = await w.send({ path: MESSAGES, headers: { "x-api-key": token, [WORKSPACE_HEADER]: undefined }, body: anthropicBody() });
    expect(bare.status).toBe(403);
    // Asking for a token is stamped too: a capability is good for its own workspace's worker alone.
    const noStamp = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability(), [WORKSPACE_HEADER]: undefined } });
    const otherStamp = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability(), [WORKSPACE_HEADER]: OTHER_WORKSPACE } });
    expect([noStamp.status, otherStamp.status]).toEqual([403, 403]);
    expect(w.proxy.tokens.liveTokens()).toBe(1);
    expect(w.provider.calls).toHaveLength(0);
  });

  it("keeps one operation's token from another operation's budget, models and ledger (a wrong-task token is refused)", async () => {
    const w = await world();
    w.active.add(`${WORKSPACE}:${OTHER_OPERATION}:1`);
    w.allowed.set(OTHER_OPERATION, [w.routes.openai]);
    const a = await tokenOf(w);
    const b = await tokenOf(w, { operationId: OTHER_OPERATION });
    // B's token may call only what B was granted.
    const wrongModel = await w.send({ path: MESSAGES, headers: asWorker(b), body: anthropicBody() });
    expect(wrongModel.status).toBe(403);
    expect(errorOf(wrongModel).code).toBe("model_not_allowed");
    expect((await w.send({ path: RESPONSES, headers: asWorker(a), body: { model: "openai/gpt-test", input: [], stream: false } })).status).toBe(200);
    expect((await w.send({ path: RESPONSES, headers: asWorker(b), body: { model: "openai/gpt-test", input: [], stream: false } })).status).toBe(200);
    expect(w.metered.map((item) => item.entry.entryId.split(":")[0])).toEqual([OPERATION, OTHER_OPERATION]);
    expect(w.proxy.tokens.ledger(OPERATION).spentMicros).toBe(3_200);
    expect(w.proxy.tokens.ledger(OTHER_OPERATION).spentMicros).toBe(3_200);
  });

  it("ends a token with its operation: once the operation stops holding its workspace the token is refused and revoked", async () => {
    const w = await world();
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    w.active.clear();
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(answer.status).toBe(403);
    expect(errorOf(answer).code).toBe("operation_ended");
    expect(w.proxy.tokens.lookup(token)).toEqual({ ok: false, reason: "unknown" });
    expect(w.provider.calls).toHaveLength(1);
  });

  it("serves only POST on the model routes, and only the three model routes", async () => {
    const w = await world();
    const token = await tokenOf(w);
    expect((await w.send({ method: "GET", path: MESSAGES, headers: asWorker(token) })).status).toBe(405);
    for (const path of [`${MODEL_PROXY_PREFIX}/v1/models`, `${MODEL_PROXY_PREFIX}/v1/messages/batches`, `${MODEL_PROXY_PREFIX}/`, `${MODEL_PROXY_PREFIX}/v1/embeddings`]) {
      expect((await w.send({ path, headers: asWorker(token), body: anthropicBody() })).status, path).toBe(404);
    }
    expect(w.provider.calls).toHaveLength(0);
  });
});

describe("what a call may ask for", () => {
  it("refuses a model the token was not granted, a route that is not the model's, and a field or header Cloud's guard refuses", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const refused: Array<[string, Parameters<ModelProxyWorld["send"]>[0], number, string]> = [
      ["unknown model", { path: MESSAGES, headers: asWorker(token), body: anthropicBody({ model: "anthropic/claude-other" }) }, 403, "model_not_allowed"],
      ["a raw provider model id", { path: MESSAGES, headers: asWorker(token), body: anthropicBody({ model: "claude-test" }) }, 403, "model_not_allowed"],
      ["no model", { path: MESSAGES, headers: asWorker(token), body: { messages: [] } }, 403, "model_not_allowed"],
      ["the wrong route for the model", { path: CHAT, headers: asWorker(token), body: { model: "anthropic/claude-test", messages: [] } }, 400, "request_not_allowed"],
      ["a key in the body", { path: MESSAGES, headers: asWorker(token), body: anthropicBody({ api_key: "k" }) }, 400, "request_not_allowed"],
      ["another provider address", { path: MESSAGES, headers: asWorker(token), body: anthropicBody({ api_base: "http://127.0.0.1:1" }) }, 400, "request_not_allowed"],
      ["fallbacks", { path: MESSAGES, headers: asWorker(token), body: anthropicBody({ fallbacks: ["a"] }) }, 400, "request_not_allowed"],
      ["a proxy-control header", { path: MESSAGES, headers: asWorker(token, { "x-litellm-api-key": "k" }), body: anthropicBody() }, 400, "request_not_allowed"],
      ["a billing header", { path: MESSAGES, headers: asWorker(token, { "openai-organization": "org" }), body: anthropicBody() }, 400, "request_not_allowed"],
      ["a beta it does not know", { path: MESSAGES, headers: asWorker(token, { "anthropic-beta": "files-api-2025-04-14" }), body: anthropicBody() }, 400, "request_not_allowed"],
      ["not JSON", { path: MESSAGES, headers: asWorker(token), raw: "{not json" }, 400, "invalid_json"],
      ["a JSON array", { path: MESSAGES, headers: asWorker(token), raw: "[]" }, 400, "invalid_json"],
    ];
    for (const [what, request, status, code] of refused) {
      const answer = await w.send(request);
      expect(answer.status, what).toBe(status);
      expect((JSON.parse(answer.text) as { error: { code: string } }).error.code, what).toBe(code);
    }
    expect(w.provider.calls).toHaveLength(0);
  });

  it("refuses a request over 8 MiB without forwarding it", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), raw: JSON.stringify(anthropicBody({ system: "x".repeat(8 * 1_048_576) })) }).catch(() => ({ status: 413 }));
    expect(answer.status).toBe(413);
    expect(w.provider.calls).toHaveLength(0);
  });

  it("refuses a model call when the provider has no key, as a refusal and not as a failed call", async () => {
    const w = await world();
    const token = await tokenOf(w);
    w.keyStore.remove("anthropic");
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe("no anthropic key is set on this computer");
  });
});

describe("the provider's answers, and the key", () => {
  it("never passes on a provider's error as it came: a 401 that repeats the key is shortened to nothing of it", async () => {
    const w = await world();
    w.provider.mode = "unauthorized-echo";
    const token = await tokenOf(w);
    for (const [path, headers, body] of [[MESSAGES, asWorker(token), anthropicBody()], [RESPONSES, { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, { model: "openai/gpt-test", input: [] }]] as const) {
      const answer = await w.send({ path, headers, body });
      expect(answer.status).toBe(502);
      expect(errorOf(answer).code).toBe("provider_refused_key");
      for (const key of Object.values(w.keys)) expect(everythingVisible(w, answer)).not.toContain(key);
    }
  });

  it("keeps a rate limit's and a server error's status so the worker retries, with the provider's words scrubbed and no provider header", async () => {
    const w = await world();
    const token = await tokenOf(w);
    w.provider.mode = "rate-limit";
    const limited = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("7");
    expect(limited.headers["x-secret-header"]).toBeUndefined();
    w.provider.mode = "server-error";
    const broken = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(broken.status).toBe(503);
    expect(broken.text).not.toContain(w.keys.anthropic.slice(0, 16));
    expect(broken.text).not.toContain(w.keys.anthropic.slice(-10));
    expect(broken.text).toContain("overloaded");
    expect(w.metered).toHaveLength(0);
  });

  it("never follows a redirect: the next address would receive the key", async () => {
    const w = await world();
    w.provider.mode = "redirect";
    const token = await tokenOf(w);
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(answer.status).toBe(502);
    expect(everythingVisible(w, answer)).not.toContain(w.keys.anthropic);
    expect(w.provider.calls).toHaveLength(1);
  });

  it("cuts off an answer that contains the key, streamed or whole", async () => {
    const w = await world();
    const token = await tokenOf(w);
    w.provider.mode = "echo-key-whole";
    const whole = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false }) });
    expect(whole.status).toBe(502);
    expect(whole.text).not.toContain(w.keys.anthropic);
    w.provider.mode = "echo-key-in-stream";
    const streamed = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() }).catch((error: unknown) => ({ status: 0, text: String(error), headers: {} }));
    expect(streamed.text).not.toContain(w.keys.anthropic);
    expect(w.events.some((event) => event.event === "stream_stopped")).toBe(true);
  });

  it("stops the provider's call when the worker goes away mid-answer", async () => {
    const w = await world();
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: w.callback.tcpPort, method: "POST", path: MESSAGES, headers: { host: `host.docker.internal:${w.callback.tcpPort}`, "content-type": "application/json", ...asWorker(token) } }, (incoming) => {
        incoming.once("data", () => { outgoing.destroy(); resolve(); });
      });
      outgoing.on("error", () => resolve());
      outgoing.end(JSON.stringify(anthropicBody()));
      setTimeout(() => reject(new Error("no first chunk")), 5_000);
    });
    for (let attempt = 0; attempt < 100 && w.provider.aborted === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.provider.aborted).toBe(1);
    expect(w.proxy.tokens.ledger(OPERATION).inFlight).toBe(0);
  });
});

describe("the task's budget and limits", () => {
  it("lets calls run while the spend is under the budget, then refuses in the words the worker reads as the task's budget", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 10_000, currency: "USD" });
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    expect(w.proxy.tokens.ledger(OPERATION).spentMicros).toBe(18_000);
    const over = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(over.status).toBe(422);
    expect(errorOf(over)).toMatchObject({ type: "budget_exceeded", message: "Budget has been exceeded! Key=task" });
    expect(w.provider.calls).toHaveLength(2);
  });

  it("holds the spend across new tokens for the same operation, so asking again does not reset the budget", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 9_000, currency: "USD" });
    const first = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(first), body: anthropicBody() })).status).toBe(200);
    expect((await askForToken(w, w.capability())).status).toBe(402);
    expect((await w.send({ path: MESSAGES, headers: asWorker(first), body: anthropicBody() })).status).toBe(422);
  });

  it("refuses a model with no price when a budget is held, because the budget could not be kept", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 1_000_000, currency: "USD" });
    const unpriced = { ...w.routes.anthropic, alias: "anthropic/claude-unpriced", model: "claude-unpriced" };
    w.allowed.set(OPERATION, [unpriced, w.routes.anthropic]);
    const token = await tokenOf(w);
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ model: "anthropic/claude-unpriced" }) });
    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toMatch(/no price on this computer/u);
    expect(w.provider.calls).toHaveLength(0);
  });

  it("runs a model with no price when there is no budget, and counts the call as unpriced", async () => {
    const w = await world();
    const unpriced = { ...w.routes.anthropic, alias: "anthropic/claude-unpriced", model: "claude-unpriced" };
    w.allowed.set(OPERATION, [unpriced]);
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ model: "anthropic/claude-unpriced", stream: false }) })).status).toBe(200);
    expect(w.proxy.tokens.ledger(OPERATION)).toMatchObject({ spentMicros: 0, unpriced: 1 });
    expect(w.metered[0]!.result).toEqual({ cost: null, source: "unknown" });
  });

  it("limits the calls one operation has running at once", async () => {
    const w = await world({ maxConcurrentPerOperation: 1 });
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    const first = w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    for (let attempt = 0; attempt < 100 && w.provider.calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBe("2");
    expect((await first).status).toBe(200);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false }) })).status).toBe(200);
  });
});

describe("through the worker's egress gateway, with the worker's own client", () => {
  async function throughGateway(w: ModelProxyWorld, workspaceId = WORKSPACE) {
    const gateway = await loadGatewayRelay({ workspaceId, callbackPort: w.callback.tcpPort });
    open.push(() => gateway.dispose());
    return gateway;
  }

  it("lets the worker's model-access client and model library run a call, and the key never reaches the worker", async () => {
    const w = await world();
    const gateway = await throughGateway(w);
    const capability = w.capability();
    const source = modelAccessSource({ controlPlaneUrl: gateway.url, capability });
    const access = await source();
    // What the worker holds: an address, a token and an expiry. The worker's process environment has no key either.
    expect(JSON.stringify(access)).not.toMatch(new RegExp(Object.values(w.keys).join("|"), "u"));
    expect(Object.values(process.env).join("\n")).not.toMatch(new RegExp(Object.values(w.keys).join("|"), "u"));
    const { route, workerRoute } = localRoute("anthropic", "claude-test");
    const environment: NodeJS.ProcessEnv = { AGENTX_MODEL_PROXY_URL: `${gateway.url}${MODEL_PROXY_PREFIX}` };
    const resolved = await createModelRuntimeWithFallback({ provider: "anthropic", modelId: "claude-test" }, "worker", {
      environment, proxy: { baseUrl: environment.AGENTX_MODEL_PROXY_URL!, apiKey: async () => (await source()).apiKey, route: workerRoute },
    });
    expect(resolved.model).toMatchObject({ provider: ROUTE_PROVIDER, modelId: route.alias });
    const context: Context = { messages: [{ role: "user", content: "say hello", timestamp: 0 }], tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }] };
    const reply = await resolved.runtime.completeSimple(resolved.runtime.getModel(resolved.model.provider, resolved.model.modelId)!, context);
    expect(JSON.stringify(reply.content)).toContain("hello");
    // The provider was called with the real key, the worker's client with none.
    expect(w.provider.calls).toHaveLength(1);
    expect(w.provider.calls[0]!.headers["x-api-key"]).toBe(w.keys.anthropic);
    expect(w.provider.calls[0]!.body.model).toBe("claude-test");
    expect(JSON.stringify(reply)).not.toContain(w.keys.anthropic);
    expect(w.metered).toHaveLength(1);
    expect(w.metered[0]!.result.cost?.micros).toBeGreaterThan(0);
    expect(everythingVisible(w, { text: JSON.stringify(reply) })).not.toContain(w.keys.anthropic);
  });

  it("stamps the worker's own workspace on every call, whatever the worker sends, so another worker's token is refused", async () => {
    const w = await world();
    w.active.add(`${OTHER_WORKSPACE}:${OTHER_OPERATION}:1`);
    const mine = await throughGateway(w, WORKSPACE);
    const theirs = await throughGateway(w, OTHER_WORKSPACE);
    const get = async (base: string, headers: Record<string, string>) => {
      const answer = await fetch(`${base}/v1/internal/model-access`, { headers });
      return { status: answer.status, text: await answer.text() };
    };
    const token = apiKeyOf(await get(mine.url, { [CAPABILITY_HEADER]: w.capability() }));
    // Used from the other worker's gateway: refused, even though the worker claims to be the first one.
    const stolen = await fetch(`${theirs.url}${MESSAGES}`, { method: "POST", headers: { "x-api-key": token, [WORKSPACE_HEADER]: WORKSPACE, "content-type": "application/json" }, body: JSON.stringify(anthropicBody({ stream: false })) });
    expect(stolen.status).toBe(403);
    expect(((await stolen.json()) as { error: { code: string } }).error.code).toBe("other_workspace");
    // Used from its own gateway, and claiming to be someone else: the gateway overwrites the claim.
    const own = await fetch(`${mine.url}${MESSAGES}`, { method: "POST", headers: { "x-api-key": token, [WORKSPACE_HEADER]: OTHER_WORKSPACE, "content-type": "application/json" }, body: JSON.stringify(anthropicBody({ stream: false })) });
    expect(own.status).toBe(200);
    await own.arrayBuffer();
    // The second worker cannot use the first one's capability to ask for a token either: it is stamped with its own workspace.
    const wrong = await get(theirs.url, { [CAPABILITY_HEADER]: w.capability() });
    expect(wrong.status).toBe(403);
    expect(wrong.text).not.toContain("rvm_");
  });

  it("relays nothing but the callback routes and the model routes", async () => {
    const w = await world();
    const gateway = await throughGateway(w);
    for (const [method, path] of [["GET", "/v1/local/status"], ["POST", "/v1/internal/model-access"], ["GET", "/v1/internal/model-proxy/v1/messages"], ["POST", "/v1/internal/model-proxy/v1/models"], ["GET", "/healthz"]] as const) {
      const answer = await fetch(`${gateway.url}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect([404, 405], `${method} ${path}`).toContain(answer.status);
      await answer.arrayBuffer();
    }
    expect(w.provider.calls).toHaveLength(0);
  });

  it("tells the worker's client that the budget is spent, as the task's budget, and that no key is set, as the model refusal", async () => {
    const w = await world();
    const gateway = await throughGateway(w);
    w.budgets.set(OPERATION, { micros: 1, currency: "USD" });
    const token = await tokenOf(w);
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    await expect(modelAccessSource({ controlPlaneUrl: gateway.url, capability: w.capability() })()).rejects.toMatchObject({ name: "ModelBudgetExhaustedError", scope: "task" });
    const fresh = await world();
    const freshGateway = await throughGateway(fresh);
    for (const provider of ["anthropic", "openai", "openrouter"]) fresh.keyStore.remove(provider);
    const refused = await modelAccessSource({ controlPlaneUrl: freshGateway.url, capability: fresh.capability() })().catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: "ModelNotAllowedError" });
    expect((refused as { text: string }).text).toMatch(/key is set on this computer/u);
  });
});
