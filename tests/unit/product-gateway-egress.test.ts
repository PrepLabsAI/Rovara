// The worker's side of the product bridge: a ModelEgress that forwards a checked Gemini frame to the gateway's product route
// with the task token, and nothing of the sandbox's own credentials. No network: an injected fetch records every request.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelEgressEvent, ModelEgressFrame, ModelEgressScope } from "@agentx/contracts";
import { createProductGatewayEgress, productQuery, PRODUCT_BRIDGE_CONTRACT } from "../../packages/worker/src/product-gateway-egress.js";

const CONTRACT = new URL("../../contracts/shared/model-gateway-product-ai.v1.json", import.meta.url);
const GATEWAY = "https://gateway.example.test";
const TOKEN = "task-token-abcdefghijklmnop";
const DUMMY = "dummy-google-key-123456";
const scope = Object.freeze({}) as unknown as ModelEgressScope;
const enc = new TextEncoder();
const frame = (over: Partial<ModelEgressFrame> = {}): ModelEgressFrame => ({
  row: "gemini", method: "POST", path: "/v1beta/models/gemini-2.5-flash:generateContent", query: "",
  headers: [["content-type", "application/json"], ["x-goog-api-key", DUMMY], ["x-goog-user-project", "p"], ["authorization", `Bearer ${DUMMY}`], ["x-goog-api-client", "genai-py/1.0"], ["cookie", "c=1"], ["x-rovara-eval-scope", "forged"], ["x-api-key", "forged"]],
  body: enc.encode("{\"contents\":[]}"), ...over,
});
interface Sent { url: string; method: string; headers: Record<string, string>; body: string; redirect: string | undefined; signal: AbortSignal | undefined }
function gateway(answer: (sent: Sent) => Response | Promise<Response> = () => new Response("{\"candidates\":[]}", { status: 200, headers: { "content-type": "application/json" } })) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const s: Sent = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method: init?.method ?? "GET", headers, body: init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "", redirect: init?.redirect, signal: init?.signal ?? undefined };
    sent.push(s);
    return answer(s);
  }) as typeof fetch;
  return { sent, fetchImpl };
}
const egressOf = (g: ReturnType<typeof gateway>, over: { tokenSource?: () => Promise<string>; responseBytes?: number } = {}) =>
  createProductGatewayEgress({ gatewayUrl: GATEWAY, tokenSource: over.tokenSource ?? (async () => TOKEN), fetch: g.fetchImpl, ...(over.responseBytes === undefined ? {} : { responseBytes: over.responseBytes }) });
async function run(g: ReturnType<typeof gateway>, f: ModelEgressFrame = frame(), over: Parameters<typeof egressOf>[1] = {}, signal?: AbortSignal): Promise<ModelEgressEvent[]> {
  const out: ModelEgressEvent[] = [];
  for await (const e of egressOf(g, over).forward(scope, f, signal === undefined ? undefined : { signal })) out.push(e);
  return out;
}
const settle = (list: ModelEgressEvent[]) => list[list.length - 1] as Extract<ModelEgressEvent, { kind: "settle" }>;
const text = (list: ModelEgressEvent[]) => new TextDecoder().decode(Buffer.concat(list.filter((e): e is Extract<ModelEgressEvent, { kind: "chunk" }> => e.kind === "chunk").map(e => e.bytes)));
const errorAnswer = (status: number, type: string, message = "x", headers: Record<string, string> = {}) => () => new Response(JSON.stringify({ error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });

describe("the contract copy", () => {
  it("is byte for byte the gateway's (SHA-256 pinned)", () => {
    expect(createHash("sha256").update(readFileSync(CONTRACT)).digest("hex")).toBe("edf5eab5748e1e8f4ba204cbede6b0c2140424cd9fc5ef7ef2b487213bf871c8");
  });
  it("says what this egress does", () => {
    const c = JSON.parse(readFileSync(CONTRACT, "utf8")) as { version: number; routePrefix: string; token: { headers: string[] }; providers: Array<{ name: string; versions: string[]; model: string; workerRemovesHeaders: string[]; workerRemovesQuery: string[] }>; refusals: Array<{ type: string }> };
    expect(c.version).toBe(PRODUCT_BRIDGE_CONTRACT.version);
    expect(c.routePrefix).toBe(PRODUCT_BRIDGE_CONTRACT.routePrefix);
    expect(c.token.headers).toContain(PRODUCT_BRIDGE_CONTRACT.tokenHeader);
    expect(c.providers.map(p => p.name)).toEqual([PRODUCT_BRIDGE_CONTRACT.provider]);
    const [p] = c.providers;
    expect(p!.versions).toEqual([...PRODUCT_BRIDGE_CONTRACT.versions]);
    expect(p!.model).toBe(PRODUCT_BRIDGE_CONTRACT.model);
    expect(p!.workerRemovesHeaders).toEqual([...PRODUCT_BRIDGE_CONTRACT.workerRemovesHeaders]);
    expect(p!.workerRemovesQuery).toEqual([...PRODUCT_BRIDGE_CONTRACT.workerRemovesQuery]);
  });
  it("every refusal type the contract lists has a fixed answer here", async () => {
    const c = JSON.parse(readFileSync(CONTRACT, "utf8")) as { refusals: Array<{ status: number; type: string }> };
    for (const r of c.refusals) {
      const out = await run(gateway(errorAnswer(r.status, r.type)));
      expect(settle(out).costMicros).toBe(0);
      expect(text(out)).not.toBe("x");
    }
  });
});

describe("what leaves", () => {
  it("forwards to the product route with the task token and only the allow-listed headers", async () => {
    const g = gateway();
    await run(g);
    expect(g.sent).toHaveLength(1);
    const [s] = g.sent;
    expect(s!.url).toBe(`${GATEWAY}/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent`);
    expect(s!.method).toBe("POST"); expect(s!.redirect).toBe("error");
    expect(s!.headers).toEqual({ "content-type": "application/json", "x-goog-api-client": "genai-py/1.0", "x-api-key": TOKEN });
    expect(s!.body).toBe("{\"contents\":[]}");
  });
  it("removes every key= from the query and keeps alt=sse for the stream", async () => {
    const g = gateway();
    await run(g, frame({ path: "/v1/models/gemini-2.5-pro:streamGenerateContent", query: `key=${DUMMY}&alt=sse&key=again` }));
    expect(g.sent[0]!.url).toBe(`${GATEWAY}/v1/product/gemini/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse`);
    expect(JSON.stringify(g.sent)).not.toContain(DUMMY);
  });
  it("removes a key= from a generateContent query", async () => {
    const g = gateway();
    await run(g, frame({ query: `key=${DUMMY}` }));
    expect(g.sent[0]!.url).toBe(`${GATEWAY}/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent`);
  });
  it("passes the caller's abort signal", async () => {
    const g = gateway(); const controller = new AbortController();
    await run(g, frame(), {}, controller.signal);
    expect(g.sent[0]!.signal).toBe(controller.signal);
  });
  it.each([
    ["a dot segment", { path: "/v1beta/models/../../eval/release" }],
    ["an encoded character", { path: "/v1beta/models/gemini%2e:generateContent" }],
    ["an upper-case model", { path: "/v1beta/models/Gemini:generateContent" }],
    ["another operation", { path: "/v1beta/models/m:countTokens" }],
    ["another version", { path: "/v2/models/m:generateContent" }],
    ["a stream with no alt=sse", { path: "/v1beta/models/m:streamGenerateContent" }],
    ["generateContent with alt=sse", { query: "alt=sse" }],
    ["another query key", { query: "foo=1" }],
    ["a keyed name that is not key", { query: "keys=1" }],
    ["a GET", { method: "GET" }],
  ] as Array<[string, Partial<ModelEgressFrame>]>)("%s is refused before anything is sent", async (_n, over) => {
    const g = gateway();
    const out = await run(g, frame(over));
    expect(settle(out)).toMatchObject({ class: "refused", costMicros: 0 });
    expect(g.sent).toEqual([]);
  });
  it("a frame that does not parse is refused before anything is sent", async () => {
    const g = gateway();
    expect(settle(await run(g, frame({ row: "Bad Row" })))).toMatchObject({ class: "refused", refusal: "bad_request" });
    expect(g.sent).toEqual([]);
  });
  it.each([["throws", async () => { throw new Error("t"); }], ["is short", async () => "short"], ["has a space", async () => "a b c d e f g h"]] as Array<[string, () => Promise<string>]>)("no call is sent when the token source %s", async (_n, tokenSource) => {
    const g = gateway();
    expect(settle(await run(g, frame(), { tokenSource }))).toMatchObject({ class: "refused", costMicros: 0 });
    expect(g.sent).toEqual([]);
  });
  it("productQuery keeps only what the gateway takes", () => {
    expect(productQuery("", "generateContent")).toBe("");
    expect(productQuery("key=a", "generateContent")).toBe("");
    expect(productQuery("key", "generateContent")).toBe("");
    expect(productQuery("alt=sse", "streamGenerateContent")).toBe("alt=sse");
    expect(productQuery("alt=sse&alt=sse", "streamGenerateContent")).toBeUndefined();
    expect(productQuery("alt=json", "streamGenerateContent")).toBeUndefined();
  });
});

describe("answers", () => {
  it("a 200 is handed on, settled ok", async () => {
    const out = await run(gateway());
    expect(out[0]).toEqual({ kind: "head", status: 200, headers: [["content-type", "application/json"]] });
    expect(text(out)).toBe("{\"candidates\":[]}");
    expect(settle(out)).toEqual({ kind: "settle", status: 200, class: "ok", costMicros: 0, estimated: false });
  });
  it("a streamed 200 is handed on chunk by chunk", async () => {
    const g = gateway(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("data: {\"a\":1}\n\n")); c.enqueue(enc.encode("data: {\"b\":2}\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }));
    const out = await run(g, frame({ path: "/v1beta/models/m:streamGenerateContent", query: "alt=sse" }));
    expect(text(out)).toBe("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
    expect(settle(out).class).toBe("ok");
  });
  it("an answer that echoes the task token is cut and never handed on", async () => {
    const g = gateway(() => new Response(`{"echo":"${TOKEN}"}`, { status: 200, headers: { "content-type": "application/json", "x-request-id": TOKEN } }));
    const out = await run(g);
    expect(JSON.stringify(out.map(e => (e.kind === "chunk" ? new TextDecoder().decode(e.bytes) : e)))).not.toContain(TOKEN);
    expect(settle(out)).toMatchObject({ class: "provider_error", costMicros: 0 });
  });
  it("an echo stops the read at once, even while the stream stays open, and cancels it", async () => {
    let cancelled = false;
    const g = gateway(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(`data: {"k":"${TOKEN}"}\n\n`)); }, cancel() { cancelled = true; } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const out = await run(g, frame({ path: "/v1beta/models/m:streamGenerateContent", query: "alt=sse" }));
    expect(settle(out).class).toBe("provider_error"); expect(text(out)).not.toContain(TOKEN); expect(cancelled).toBe(true);
  }, 5_000);
  it("an answer past the limit is cut", async () => {
    const g = gateway(() => new Response("x".repeat(5000), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await run(g, frame(), { responseBytes: 1000 });
    expect(settle(out).class).toBe("provider_error");
    expect(text(out).length).toBeLessThanOrEqual(1000);
  });
  it("a stream that breaks is a provider error", async () => {
    const g = gateway(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("data: {}\n\n")); c.error(new Error("cut")); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(settle(await run(g)).class).toBe("provider_error");
  });
  it("a caller that stops reading early cancels the body", async () => {
    let cancelled = false;
    const g = gateway(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("x".repeat(200))); }, cancel() { cancelled = true; } }), { status: 200, headers: { "content-type": "application/json" } }));
    for await (const e of egressOf(g).forward(scope, frame())) { if (e.kind === "head") break; }
    expect(cancelled).toBe(true);
  });
  it("a transport fault is a 502 provider error in the family's shape", async () => {
    const out = await run(gateway(() => { throw new Error(`socket ${TOKEN}`); }));
    expect(out[0]).toMatchObject({ kind: "head", status: 502 });
    expect(settle(out)).toMatchObject({ class: "provider_error", costMicros: 0 });
    expect(text(out)).not.toContain(TOKEN);
  });
  const refusals: Array<[number, string, string, string, string]> = [
    [422, "budget_exceeded", "Product AI budget has been exceeded! Key=task", "cap", "cap"],
    [429, "budget_held", "budget is held by another call", "cap", "cap"],
    [429, "busy", "x", "cap", "cap"],
    [502, "product_key_refused", "not run: the product key was refused (check it in Settings)", "key_refused", "key_refused"],
    [429, "provider_limited", "x", "rate_limit", "rate_limit"],
    [429, "provider_quota", "x", "quota", "quota"],
    [429, "provider_overloaded", "x", "overloaded", "overloaded"],
    [401, "authentication_error", "invalid or expired model access", "refused", "not_allowed"],
    [403, "task_ended", "task ended", "refused", "not_allowed"],
    [404, "not_set_up", "product AI is not set up for this project", "refused", "not_found"],
    [400, "invalid_request", "request not allowed", "refused", "bad_request"],
    [413, "request_too_large", "x", "refused", "too_large"],
  ];
  it.each(refusals)("a %i %s is the fixed %s answer, at no cost, with none of the gateway's words", async (status, type, message, cls, word) => {
    const out = await run(gateway(errorAnswer(status, type, `${message} secret-words`)));
    expect(settle(out)).toMatchObject({ class: cls, refusal: word, costMicros: 0, estimated: false });
    expect((out[0] as Extract<ModelEgressEvent, { kind: "head" }>).headers).toContainEqual(["x-rovara-refusal", word]);
    expect(text(out)).not.toContain("secret-words");
  });
  it("the gateway's \"budget exceeded by one call\" is the overrun sentence", async () => {
    const out = await run(gateway(errorAnswer(422, "budget_exceeded", "budget exceeded by one call")));
    expect(text(out)).toContain("budget exceeded by one call");
    const plain = await run(gateway(errorAnswer(422, "budget_exceeded", "Product AI budget has been exceeded! Key=task")));
    expect(text(plain)).not.toContain("by one call");
  });
  it("a retry-after the gateway sent is kept, a malformed one is not", async () => {
    const out = await run(gateway(errorAnswer(429, "busy", "x", { "retry-after": "2" })));
    expect((out[0] as Extract<ModelEgressEvent, { kind: "head" }>).headers).toContainEqual(["retry-after", "2"]);
    const bad = await run(gateway(errorAnswer(429, "busy", "x", { "retry-after": "2\r\nx: y" .replace(/\r\n/gu, " ") })));
    expect((bad[0] as Extract<ModelEgressEvent, { kind: "head" }>).headers.map(([n]) => n)).not.toContain("retry-after");
  });
  it.each([
    ["a provider error", errorAnswer(502, "provider_error", "provider unavailable"), 502],
    ["a provider refusal", errorAnswer(400, "provider_refused", "the provider refused this request"), 400],
    ["an unavailable gateway", errorAnswer(503, "unavailable", "model access unavailable"), 503],
    ["an unknown type", errorAnswer(418, "teapot", "secret"), 418],
    ["a body that is not JSON", () => new Response("<html>secret</html>", { status: 500 }), 500],
    ["an over-long error body", () => new Response(JSON.stringify({ error: { type: "busy", message: "x".repeat(70_000) } }), { status: 429 }), 502],
  ] as Array<[string, () => Response, number]>)("%s is a provider error with fixed words", async (_n, answer, status) => {
    const out = await run(gateway(answer));
    expect(settle(out)).toMatchObject({ class: "provider_error", costMicros: 0 });
    expect(text(out)).not.toContain("secret");
    if (status !== 502) expect(out[0]).toMatchObject({ status });
  });
});

describe("the gateway address", () => {
  it.each(["http://gateway.example.test", "https://u:p@gateway.example.test", "https://gateway.example.test/?a=1", "not a url"])("refuses %s", url => {
    expect(() => createProductGatewayEgress({ gatewayUrl: url, tokenSource: async () => TOKEN })).toThrow();
  });
  it("refuses a missing token source", () => {
    expect(() => createProductGatewayEgress({ gatewayUrl: GATEWAY, tokenSource: undefined as never })).toThrow();
  });
  it("allows loopback http and keeps a base path", async () => {
    const g = gateway();
    const seen: ModelEgressEvent[] = [];
    for await (const e of createProductGatewayEgress({ gatewayUrl: "http://127.0.0.1:9/gw/", tokenSource: async () => TOKEN, fetch: g.fetchImpl }).forward(scope, frame())) seen.push(e);
    expect(settle(seen).class).toBe("ok");
    expect(g.sent[0]!.url).toBe("http://127.0.0.1:9/gw/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent");
  });
});
