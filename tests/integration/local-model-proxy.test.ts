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

  it("charges the most the call could have cost, and says so, when the provider reported no usage", async () => {
    const w = await world();
    w.provider.mode = "no-usage";
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false }) })).status).toBe(200);
    expect(w.metered).toHaveLength(1);
    expect(w.metered[0]!.entry.usage.tokens.output).toBe(64);
    expect(w.metered[0]!.result.cost!.micros).toBeGreaterThanOrEqual(64 * 15);
    expect(w.events.some((event) => event.event === "unmetered" && event.code === "charged_maximum")).toBe(true);
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
  it("lets a call run while its worst case fits under the budget, then refuses in the words the worker reads as the task's budget", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 10_000, currency: "USD" });
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    expect(w.proxy.tokens.ledger(OPERATION)).toMatchObject({ spentMicros: 9_000, reservedMicros: 0 });
    // 9,000 spent, and this call could cost 1,000 or more: it does not fit.
    const over = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(over.status).toBe(422);
    expect(errorOf(over)).toMatchObject({ type: "budget_exceeded", message: "Budget has been exceeded! Key=task" });
    expect(w.provider.calls).toHaveLength(1);
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
    w.budgets.set(OPERATION, { micros: 5_000, currency: "USD" });
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

// ---- review round 1 (Opus): H1, M1-M3, L1-L4

/** Sends a streamed call and drops the connection at the first bytes of the answer, the way a worker that gives up does. */
function dropAtFirstBytes(w: ModelProxyWorld, path: string, headers: Record<string, string>, body: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: w.callback.tcpPort, method: "POST", path, headers: { host: `host.docker.internal:${w.callback.tcpPort}`, "content-type": "application/json", ...headers } }, (incoming) => {
      incoming.once("data", () => { outgoing.destroy(); resolve(); });
    });
    outgoing.on("error", () => resolve());
    outgoing.end(JSON.stringify(body));
    setTimeout(() => reject(new Error("no first bytes")), 5_000);
  });
}
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check(), what).toBe(true);
}

describe("H1: parallel calls cannot get past the cap or the budget", () => {
  it("lets exactly the cap through when a burst arrives while the key is still being read", async () => {
    const w = await world({ maxConcurrentPerOperation: 1, keyDelayMs: 5 });
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    const answers = await Promise.all(Array.from({ length: 6 }, () => w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429, 429, 429, 429, 429]);
    expect(w.provider.calls).toHaveLength(1);
    expect(w.proxy.tokens.ledger(OPERATION).inFlight).toBe(0);
  });

  it("holds each running call's worst case against the budget, so a burst cannot spend more than the budget allows", async () => {
    const w = await world({ keyDelayMs: 5 });
    w.provider.mode = "slow";
    w.budgets.set(OPERATION, { micros: 10_000, currency: "USD" });
    const token = await tokenOf(w);
    // Each call could use 400 output tokens (6,000 micros) and more: two cannot both fit under 10,000. The others fit alone, so they are told to wait (429), not that the budget is spent.
    const answers = await Promise.all(Array.from({ length: 8 }, () => w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429, 429, 429, 429, 429, 429, 429]);
    expect(answers.filter((answer) => answer.status === 429).every((answer) => answer.headers["retry-after"] === "2" && errorOf(answer).code === "budget_held")).toBe(true);
    expect(w.provider.calls).toHaveLength(1);
    expect(w.proxy.tokens.ledger(OPERATION)).toMatchObject({ spentMicros: 9_000, reservedMicros: 0, inFlight: 0 });
  });

  it("gives the reservation back when a call fails, is refused by the provider, or never reaches it", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 100_000, currency: "USD" });
    const token = await tokenOf(w);
    w.provider.mode = "server-error";
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) })).status).toBe(503);
    w.keyStore.remove("anthropic");
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) })).status).toBe(403);
    expect(w.proxy.tokens.ledger(OPERATION)).toMatchObject({ reservedMicros: 0, spentMicros: 0, inFlight: 0 });
  });
});

describe("M1: a call that did not finish cleanly is charged the most it could have cost", () => {
  it("charges an Anthropic stream the worker cut off after the content, at its output limit and not the one token seen", async () => {
    const w = await world();
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    await dropAtFirstBytes(w, MESSAGES, asWorker(token), anthropicBody());
    await until(() => w.metered.length === 1, "the call was metered");
    expect(w.metered[0]!.entry.usage.tokens.output).toBe(64);
    expect(w.proxy.tokens.ledger(OPERATION).spentMicros).toBeGreaterThanOrEqual(64 * 15);
    expect(w.events.some((event) => event.event === "unmetered" && event.code === "charged_maximum")).toBe(true);
  });

  it("charges an OpenAI-shaped stream the worker cut off, which carries no usage until its last event", async () => {
    const w = await world();
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    await dropAtFirstBytes(w, CHAT, { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, { model: "openrouter/vendor/model-test", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    await until(() => w.metered.length === 1, "the chat call was metered");
    expect(w.metered[0]!.entry.usage.tokens.output).toBe(100);
    await dropAtFirstBytes(w, RESPONSES, { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, { model: "openai/gpt-test", max_output_tokens: 300, stream: true, input: [] });
    await until(() => w.metered.length === 2, "the responses call was metered");
    expect(w.metered[1]!.entry.usage.tokens.output).toBe(300);
  });

  it("charges a stream the provider cut off, and a call that names no output limit at the assumed one", async () => {
    const w = await world();
    const token = await tokenOf(w);
    w.provider.mode = "cut";
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() }).catch(() => undefined);
    await until(() => w.metered.length === 1, "the cut stream was metered");
    expect(w.metered[0]!.entry.usage.tokens.output).toBe(64);
    w.provider.mode = "no-usage";
    await w.send({ path: RESPONSES, headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE }, body: { model: "openai/gpt-test", input: [], stream: false } });
    expect(w.metered[1]!.entry.usage.tokens.output).toBe(64_000);
  });

  it("does not charge an error answer", async () => {
    const w = await world();
    w.provider.mode = "server-error";
    const token = await tokenOf(w);
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(w.metered).toHaveLength(0);
  });
});

describe("M2: one operation cannot fill the token book", () => {
  it("keeps at most three live tokens per operation, the newest ones, and leaves room for every other operation", async () => {
    const w = await world();
    w.active.add(`${WORKSPACE}:${OTHER_OPERATION}:1`);
    const minted: string[] = [];
    for (let count = 0; count < 60; count += 1) minted.push(await tokenOf(w));
    expect(w.proxy.tokens.liveTokensOf(OPERATION)).toBe(3);
    expect(w.proxy.tokens.lookup(minted[0]!).ok).toBe(false);
    expect(w.proxy.tokens.lookup(minted[56]!).ok).toBe(false);
    for (const token of minted.slice(-3)) expect(w.proxy.tokens.lookup(token).ok).toBe(true);
    expect((await askForToken(w, w.capability({ operationId: OTHER_OPERATION }))).status).toBe(200);
    expect(w.proxy.tokens.liveTokens()).toBe(4);
  });
});

describe("M3: only the worker's own tools are served", () => {
  it("refuses a tool the provider would run on its side, on every route, before anything is forwarded", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const openai = { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE };
    const refused: Array<[string, Record<string, string>, unknown, string]> = [
      ["openai mcp", openai, { model: "openai/gpt-test", input: [], tools: [{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }] }, RESPONSES],
      ["openai web_search", openai, { model: "openai/gpt-test", input: [], tools: [{ type: "function", name: "ok" }, { type: "web_search" }] }, RESPONSES],
      ["openai code_interpreter", openai, { model: "openai/gpt-test", input: [], tools: [{ type: "code_interpreter", container: { type: "auto" } }] }, RESPONSES],
      ["openrouter web", openai, { model: "openrouter/vendor/model-test", messages: [], tools: [{ type: "openrouter:web_search" }] }, CHAT],
      ["anthropic web_search", asWorker(token), anthropicBody({ tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }), MESSAGES],
      ["anthropic code execution", asWorker(token), anthropicBody({ tools: [{ type: "code_execution_20250522", name: "code_execution" }] }), MESSAGES],
      ["anthropic bash", asWorker(token), anthropicBody({ tools: [{ type: "bash_20250124", name: "bash" }] }), MESSAGES],
      ["a tool that is not an object", asWorker(token), anthropicBody({ tools: ["web_search"] }), MESSAGES],
      ["tools that are not a list", asWorker(token), anthropicBody({ tools: { type: "web_search" } }), MESSAGES],
    ];
    for (const [what, headers, body, path] of refused) {
      const answer = await w.send({ path, headers, body });
      expect(answer.status, what).toBe(400);
      expect(errorOf(answer).code, what).toBe("request_not_allowed");
    }
    const words = errorOf(await w.send({ path: RESPONSES, headers: openai, body: refused[0]![2] })).message;
    expect(words).toContain("tool type 'mcp' at tools[0]");
    expect(words).toContain("only function tools are served");
    expect(w.provider.calls).toHaveLength(0);
  });

  it("serves the worker's own function tools", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const openai = { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: WORKSPACE };
    const fn = { type: "function", name: "read_file", parameters: { type: "object" } };
    expect((await w.send({ path: RESPONSES, headers: openai, body: { model: "openai/gpt-test", input: [], stream: false, tools: [fn] } })).status).toBe(200);
    expect((await w.send({ path: CHAT, headers: openai, body: { model: "openrouter/vendor/model-test", messages: [], stream: false, tools: [{ type: "function", function: { name: "read_file" } }] } })).status).toBe(200);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ stream: false, tools: [{ name: "read_file", description: "d", input_schema: { type: "object" } }, { type: "custom", name: "other", input_schema: { type: "object" } }] }) })).status).toBe(200);
    expect(w.provider.calls).toHaveLength(3);
  });
});

describe("L1: no byte of a key reaches the worker, even when the key is split across chunks", () => {
  it("holds back the end of every chunk until the next arrives, finds the key whole, and cuts the stream before any part of it was written", async () => {
    const w = await world();
    w.provider.mode = "split-key-in-stream";
    const token = await tokenOf(w);
    const received: string[] = [];
    await new Promise<void>((resolve) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: w.callback.tcpPort, method: "POST", path: MESSAGES, headers: { host: `host.docker.internal:${w.callback.tcpPort}`, "content-type": "application/json", ...asWorker(token) } }, (incoming) => {
        incoming.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")));
        incoming.on("end", () => resolve());
        incoming.on("error", () => resolve());
        incoming.on("close", () => resolve());
      });
      outgoing.on("error", () => resolve());
      outgoing.end(JSON.stringify(anthropicBody()));
    });
    const seen = received.join("");
    // Not the key, and not even the first half of it that went out in the first chunk.
    expect(seen).not.toContain(w.keys.anthropic.slice(0, 10));
    expect(seen).not.toContain("the key is sk-");
    expect(w.events.some((event) => event.event === "stream_stopped")).toBe(true);
  });

  it("still delivers an ordinary stream whole, including its last bytes", async () => {
    const w = await world();
    const token = await tokenOf(w);
    const answer = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(answer.text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    expect(answer.text).toContain("message_delta");
  });
});

describe("L2: a worker that stops reading does not hold a call open", () => {
  it("ends the copy when the time runs out, frees the slot and charges the call", async () => {
    const w = await world({ requestTimeoutMs: 400, maxConcurrentPerOperation: 1 });
    w.provider.mode = "flood";
    const token = await tokenOf(w);
    const outgoing = httpRequest({ host: "127.0.0.1", port: w.callback.tcpPort, method: "POST", path: MESSAGES, headers: { host: `host.docker.internal:${w.callback.tcpPort}`, "content-type": "application/json", ...asWorker(token) } }, (incoming) => {
      incoming.pause(); // reads nothing: the proxy's writes back up
    });
    outgoing.on("error", () => undefined);
    outgoing.end(JSON.stringify(anthropicBody()));
    try {
      await until(() => w.proxy.tokens.ledger(OPERATION).inFlight === 1, "the call started");
      await until(() => w.proxy.tokens.ledger(OPERATION).inFlight === 0, "the stalled copy ended at the timeout");
      await until(() => w.metered.length === 1, "and was charged");
    } finally {
      outgoing.destroy();
    }
  });
});

describe("L3: the budget's currency is checked when a token is asked for too", () => {
  it("refuses a token request whose budget is in another currency than the spend, and a call priced in another currency than its budget", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 1_000_000, currency: "USD" });
    const token = await tokenOf(w);
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(200);
    w.budgets.set(OPERATION, { micros: 1_000_000, currency: "EUR" });
    const again = await w.send({ method: "GET", path: "/v1/internal/model-access", headers: { [CAPABILITY_HEADER]: w.capability() } });
    expect(again.status).toBe(403);
    expect(errorOf(again).message).toMatch(/another currency/u);
    const fresh = await world();
    fresh.budgets.set(OPERATION, { micros: 1_000_000, currency: "EUR" });
    const eur = await tokenOf(fresh);
    const priced = await fresh.send({ path: MESSAGES, headers: asWorker(eur), body: anthropicBody() });
    expect(priced.status).toBe(403);
    expect(errorOf(priced).message).toMatch(/another currency/u);
    expect(fresh.provider.calls).toHaveLength(0);
  });
});

describe("L4: a finished operation's spend record is freed", () => {
  it("forgets the operation's ledger and tokens when it is seen to have ended", async () => {
    const w = await world();
    const token = await tokenOf(w);
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(w.proxy.tokens.ledgerCount()).toBe(1);
    w.active.clear();
    expect((await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() })).status).toBe(403);
    expect(w.proxy.tokens.ledgerCount()).toBe(0);
    expect(w.proxy.tokens.liveTokens()).toBe(0);
  });
});

// ---- review round 2 leftovers

describe("a call that does not fit the budget: wait, or the budget is spent", () => {
  it("says 429 with Retry-After while other calls hold the budget, and 422 once it is spent or cannot pay for the call alone", async () => {
    const w = await world();
    w.budgets.set(OPERATION, { micros: 10_000, currency: "USD" });
    w.provider.mode = "slow";
    const token = await tokenOf(w);
    const first = w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) });
    for (let attempt = 0; attempt < 100 && w.proxy.tokens.ledger(OPERATION).reservedMicros === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) });
    expect(waiting.status).toBe(429);
    expect(waiting.headers["retry-after"]).toBe("2");
    expect(errorOf(waiting)).toMatchObject({ code: "budget_held" });
    expect((await first).status).toBe(200);
    // Spent 9,000 of 10,000: nothing running now, and a call that could cost 6,000 does not fit even alone: the budget is spent for it.
    const spent = await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody({ max_tokens: 400 }) });
    expect(spent.status).toBe(422);
    expect(errorOf(spent)).toMatchObject({ type: "budget_exceeded" });
    expect(w.proxy.tokens.ledger(OPERATION).reservedMicros).toBe(0);
  });
});

describe("the reservation estimate", () => {
  it("reserves one token to each byte of the request for input, at most two million, and the named output limit", async () => {
    const { worstCaseUsage, ASSUMED_MAX_INPUT_TOKENS } = await import("../../packages/broker/src/local/model-proxy/index.js");
    expect(worstCaseUsage({ max_tokens: 64 }, 1_000)).toEqual({ input: 1_000, output: 64, cacheRead: 0, cacheWrite: 0 });
    expect(worstCaseUsage({}, 10_000_000).input).toBe(ASSUMED_MAX_INPUT_TOKENS);
    expect(worstCaseUsage({ max_output_tokens: 300 }, 1).output).toBe(300);
    expect(worstCaseUsage({}, 1).output).toBe(64_000);
  });
});

describe("an operation that settles", () => {
  it("frees its tokens and spend record at once when the task flow says it ended", async () => {
    const w = await world();
    const token = await tokenOf(w);
    await w.send({ path: MESSAGES, headers: asWorker(token), body: anthropicBody() });
    expect(w.proxy.tokens.ledgerCount()).toBe(1);
    w.proxy.operationEnded(OPERATION);
    expect(w.proxy.tokens.ledgerCount()).toBe(0);
    expect(w.proxy.tokens.lookup(token)).toEqual({ ok: false, reason: "unknown" });
    w.proxy.operationEnded(OPERATION); // twice is nothing
  });
});
