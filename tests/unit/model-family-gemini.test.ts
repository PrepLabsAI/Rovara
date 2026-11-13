// TE-F0a: the Gemini and OpenAI-compatible family shapes: the request router on every path form of the redirect check, the response builders (JSON, SSE, JSON array), the GCE metadata route table, and the one entry the
// helper will call. Pure: a test fails if anything opens a socket or calls fetch.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GCE_METADATA_ROUTES,
  GEMINI_INT_ENCODING_VERIFIED,
  GEMINI_OPERATIONS,
  GEMINI_ROUTE_REFUSALS,
  buildGeminiGenerateContent,
  buildGeminiStreamChunks,
  geminiJsonArrayBody,
  geminiSseBody,
  routeGeminiRequest,
  routeMetadataRequest,
  serveMetadataRequest,
} from "../../packages/contracts/src/model-family-gemini.js";
import { MODEL_REPLY_MAX_CHARS, chunkText, parseSseText } from "../../packages/contracts/src/model-family-common.js";
import { buildChatCompletion, buildChatCompletionStream, routeOpenAiCompatibleRequest } from "../../packages/contracts/src/model-family-openai.js";
import { serveModelRequest } from "../../packages/contracts/src/model-serve.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import type { ModelReply } from "../../packages/contracts/src/model-family-common.js";

let connects = 0;
let fetches = 0;
beforeEach(() => {
  connects = 0;
  fetches = 0;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function stub(this: net.Socket) {
    connects += 1;
    throw new Error("a socket was opened in an offline test");
  });
  vi.stubGlobal("fetch", () => {
    fetches += 1;
    throw new Error("fetch was called in an offline test");
  });
});
afterEach(() => {
  expect(connects).toBe(0);
  expect(fetches).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fakeKey = () => ["fake", "key", String(12345)].join("-"); // built at run time; matches no real key shape
const route = (path: string, over: { method?: string; query?: string; headers?: Record<string, string> } = {}) => routeGeminiRequest({ method: over.method ?? "POST", path, query: over.query ?? "", headers: over.headers ?? {} });
const reply = (over: Partial<ModelReply> = {}): ModelReply => ({ text: "Hello from the scripted reply.", finish: "stop", usage: { inputTokens: 7, outputTokens: 5 }, ...over });

describe("routeGeminiRequest: every path form of the redirect check", () => {
  it("AI Studio on v1beta (Python google-genai): generate and stream with alt=sse, key in x-goog-api-key", () => {
    expect(route("/v1beta/models/gemini-2.5-flash:generateContent", { headers: { "x-goog-api-key": fakeKey() } })).toEqual({
      ok: true, operation: "generateContent", model: "gemini-2.5-flash", mode: "ai_studio", apiVersion: "v1beta", project: undefined, location: undefined, stream: "none", enumEncoding: "string", credential: "x-goog-api-key",
    });
    expect(route("/v1beta/models/gemini-2.5-flash:streamGenerateContent", { query: "alt=sse" })).toMatchObject({ ok: true, operation: "streamGenerateContent", mode: "ai_studio", stream: "sse", credential: "none" });
  });
  it("AI Studio on v1 (JS google-genai 3.3.0)", () => {
    expect(route("/v1/models/gemini-2.5-pro:generateContent")).toMatchObject({ ok: true, mode: "ai_studio", apiVersion: "v1", model: "gemini-2.5-pro" });
    expect(route("/v1/models/gemini-2.5-pro:streamGenerateContent", { query: "alt=sse" })).toMatchObject({ ok: true, stream: "sse" });
  });
  it("accepts any API version prefix", () => {
    for (const version of ["v1", "v1beta", "v1alpha", "v1beta1", "v2", "v1beta2", "v10", "v1main"]) {
      expect(route(`/${version}/models/m:generateContent`), version).toMatchObject({ ok: true, apiVersion: version, mode: "ai_studio" });
      expect(route(`/${version}/publishers/google/models/m:generateContent`), version).toMatchObject({ ok: true, apiVersion: version, mode: "vertex_express" });
    }
    for (const version of ["", "beta", "1", "V1", "v", "v1beta1x2y3z4w5v6u", "v1/../v1"]) expect(route(`/${version}/models/m:generateContent`).ok, version).toBe(false);
  });
  it("Vertex express mode: /publishers/google/models, key in x-goog-api-key", () => {
    expect(route("/v1beta1/publishers/google/models/gemini-2.5-flash:generateContent", { headers: { "X-Goog-Api-Key": fakeKey() } })).toMatchObject({
      ok: true, mode: "vertex_express", apiVersion: "v1beta1", project: undefined, location: undefined, credential: "x-goog-api-key", model: "gemini-2.5-flash",
    });
  });
  it("Vertex project and location mode: the full path, a bearer token", () => {
    expect(route("/v1beta1/projects/my-proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent", { query: "alt=sse", headers: { authorization: `Bearer ${fakeKey()}` } })).toMatchObject({
      ok: true, operation: "streamGenerateContent", mode: "vertex_project", project: "my-proj-1", location: "us-central1", stream: "sse", credential: "authorization",
    });
    expect(route("/v1/projects/12345/locations/global/publishers/google/models/gemini-2.5-flash:generateContent")).toMatchObject({ ok: true, mode: "vertex_project", project: "12345", location: "global", apiVersion: "v1" });
  });
  it("the OpenAI-compatible forms: Gemini's /openai and Vertex's /endpoints/openapi", () => {
    expect(route("/v1beta/openai/chat/completions", { headers: { authorization: `Bearer ${fakeKey()}` } })).toMatchObject({ ok: true, mode: "openai_compatible", operation: "chat_completions", model: undefined, credential: "authorization" });
    expect(route("/v1beta/openai/embeddings")).toMatchObject({ ok: true, mode: "openai_compatible", operation: "embeddings" });
    expect(route("/v1/projects/p1/locations/us-central1/endpoints/openapi/chat/completions")).toMatchObject({ ok: true, mode: "openai_compatible", operation: "chat_completions", project: "p1", location: "us-central1" });
  });
  it("legacy REST clients: $alt=json;enum-encoding=int, plain and percent-encoded, JSON-array streaming", () => {
    for (const query of ["$alt=json;enum-encoding=int", "%24alt=json%3Benum-encoding%3Dint"]) {
      expect(route("/v1beta/models/gemini-1.5-flash:generateContent", { query }), query).toMatchObject({ ok: true, stream: "none", enumEncoding: "int" });
      expect(route("/v1beta/models/gemini-1.5-flash:streamGenerateContent", { query }), query).toMatchObject({ ok: true, stream: "json_array", enumEncoding: "int" });
    }
    expect(route("/v1/projects/p/locations/us-central1/publishers/google/models/gemini-1.5-pro:streamGenerateContent", { query: "%24alt=json%3Benum-encoding%3Dint" })).toMatchObject({ ok: true, mode: "vertex_project", stream: "json_array", enumEncoding: "int" });
    // No alt at all on a stream is the JSON array too; alt=sse always wins.
    expect(route("/v1beta/models/m:streamGenerateContent")).toMatchObject({ ok: true, stream: "json_array", enumEncoding: "string" });
    expect(route("/v1beta/models/m:streamGenerateContent", { query: "$alt=sse" })).toMatchObject({ ok: true, stream: "sse" });
    expect(route("/v1beta/models/m:streamGenerateContent", { query: "?alt=sse&foo=bar" })).toMatchObject({ ok: true, stream: "sse" });
  });
  it("routes count and embed too, and notes a key in the query without keeping it", () => {
    expect([...GEMINI_OPERATIONS]).toEqual(["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"]);
    for (const operation of GEMINI_OPERATIONS) expect(route(`/v1beta/models/m:${operation}`)).toMatchObject({ ok: true, operation });
    const keyed = route("/v1beta/models/m:generateContent", { query: `key=${fakeKey()}` });
    expect(keyed).toMatchObject({ ok: true, credential: "query_key" });
    expect(JSON.stringify(keyed)).not.toContain(fakeKey());
  });
  it("refuses with a fixed reason: method, path, model, operation, query", () => {
    expect([...GEMINI_ROUTE_REFUSALS]).toEqual(["method_not_allowed", "bad_path", "unsupported_path", "unsupported_operation", "bad_model", "bad_query", "too_large"]);
    expect(route("/v1beta/models/m:generateContent", { method: "GET" })).toEqual({ ok: false, reason: "method_not_allowed" });
    expect(route("/v1beta/models/m:generateContent", { method: "post" })).toMatchObject({ ok: true });
    expect(route("/v1beta/models/m:rawPredict")).toEqual({ ok: false, reason: "unsupported_operation" });
    expect(route("/v1beta/models/m")).toEqual({ ok: false, reason: "unsupported_operation" });
    expect(route("/v1beta/publishers/anthropic/models/m:generateContent")).toEqual({ ok: false, reason: "unsupported_path" });
    expect(route("/v1beta/tunedModels/m:generateContent")).toEqual({ ok: false, reason: "unsupported_path" });
    expect(route("/")).toEqual({ ok: false, reason: "unsupported_path" });
    for (const path of ["/v1beta/models/../m:generateContent", "/v1beta/models/%2e%2e:generateContent", "/v1beta//models/m:generateContent", "/v1beta/models/m:generateContent/", "/v1beta/models\\m:generateContent", "/v1beta/models/m@h:generateContent", "http://x/v1beta/models/m:generateContent", "v1beta/models/m:generateContent", "/v1beta/models/m:generateContent\n", "/v1beta/models/m:generateContent;x"]) {
      expect(route(path), path).toMatchObject({ ok: false });
    }
    expect(route("/v1beta/models/a b:generateContent")).toMatchObject({ ok: false });
    expect(route(`/v1beta/models/${"m".repeat(129)}:generateContent`)).toEqual({ ok: false, reason: "bad_model" });
    expect(route(`/v1beta/models/${"m".repeat(128)}:generateContent`)).toMatchObject({ ok: true });
    expect(route("/v1beta/models/:generateContent")).toEqual({ ok: false, reason: "bad_model" });
    expect(route("/v1beta/models/m:generateContent", { query: "%ZZ=1" })).toEqual({ ok: false, reason: "bad_query" });
    expect(route("/v1beta/models/m:generateContent", { query: Array.from({ length: 33 }, (_, index) => `k${String(index)}=1`).join("&") })).toEqual({ ok: false, reason: "bad_query" });
    expect(route("/v1beta/models/m:generateContent", { query: `a=${"x".repeat(3000)}` })).toEqual({ ok: false, reason: "bad_query" });
    expect(route(`/v1beta/models/m:generateContent${"x".repeat(600)}`)).toMatchObject({ ok: false });
  });
  it("is safe against hostile keys and is fast on huge input", () => {
    expect(route("/v1beta/models/m:generateContent", { query: "__proto__=x&constructor=y&alt=sse", headers: JSON.parse(`{"__proto__":"x","x-goog-api-key":"k"}`) as Record<string, string> })).toMatchObject({ ok: true });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    const started = Date.now();
    expect(route("/v1beta/models/" + "a".repeat(1_000_000))).toMatchObject({ ok: false });
    expect(route("/v1beta/models/m:generateContent", { query: "a=".concat("%41".repeat(500_000)) })).toEqual({ ok: false, reason: "bad_query" });
    expect(Date.now() - started).toBeLessThan(250);
  });
  it("accepts headers as arrays and in any case", () => {
    expect(routeGeminiRequest({ method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: { "X-GOOG-API-KEY": [fakeKey()] } })).toMatchObject({ credential: "x-goog-api-key" });
    expect(routeGeminiRequest({ method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: { Authorization: "bearer abc" } })).toMatchObject({ credential: "authorization" });
  });
});

describe("Gemini response builders", () => {
  it("builds a GenerateContentResponse with usage and a finish reason", () => {
    const body = buildGeminiGenerateContent(reply(), { model: "gemini-2.5-flash", seed: "s1" });
    expect(body).toMatchObject({
      candidates: [{ content: { role: "model", parts: [{ text: "Hello from the scripted reply." }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 },
      modelVersion: "gemini-2.5-flash",
    });
    expect(typeof (body as { responseId: unknown }).responseId).toBe("string");
    // Deterministic from the seed: no clock, no randomness.
    expect(buildGeminiGenerateContent(reply(), { model: "m", seed: "s1" })).toEqual(buildGeminiGenerateContent(reply(), { model: "m", seed: "s1" }));
    expect(buildGeminiGenerateContent(reply(), { model: "m", seed: "s1" })).not.toEqual(buildGeminiGenerateContent(reply(), { model: "m", seed: "s2" }));
  });
  it("maps every finish reason, as a name (verified) and as an integer (UNVERIFIED)", () => {
    const names = { stop: "STOP", length: "MAX_TOKENS", safety: "SAFETY", tool_calls: "STOP", other: "OTHER" } as const;
    const ints = { stop: 1, length: 2, safety: 3, tool_calls: 1, other: 5 } as const;
    for (const finish of ["stop", "length", "safety", "tool_calls", "other"] as const) {
      const text = finish === "safety" ? "" : "x";
      expect((buildGeminiGenerateContent(reply({ finish, text }), { model: "m", seed: "s" }) as { candidates: { finishReason: unknown }[] }).candidates[0]?.finishReason).toBe(names[finish]);
      expect((buildGeminiGenerateContent(reply({ finish, text }), { model: "m", seed: "s", enumEncoding: "int" }) as { candidates: { finishReason: unknown }[] }).candidates[0]?.finishReason).toBe(ints[finish]);
    }
    expect(GEMINI_INT_ENCODING_VERIFIED).toBe(false);
  });
  it("carries tool calls as functionCall parts", () => {
    const body = buildGeminiGenerateContent(reply({ text: "", toolCalls: [{ name: "get_weather", args: { city: "Oslo" } }], finish: "tool_calls" }), { model: "m", seed: "s" }) as { candidates: { content: { parts: unknown[] } }[] };
    expect(body.candidates[0]?.content.parts).toEqual([{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }]);
  });
  it("streams as SSE: 'data: <json>' then a blank line, finishReason and usage on the last chunk, no [DONE]", () => {
    const chunks = buildGeminiStreamChunks(reply({ text: "abcdefghij" }), { model: "m", seed: "s", chunkChars: 4 });
    expect(chunks.length).toBe(3);
    const lf = geminiSseBody(chunks, "lf");
    expect(lf.startsWith("data: {")).toBe(true);
    expect(lf.endsWith("}\n\n")).toBe(true);
    expect(lf).not.toContain("[DONE]");
    const parsed = parseSseText(lf, { requireSpace: true });
    expect(parsed).toMatchObject({ ok: true });
    const events = (parsed as { events: string[] }).events.map((event) => JSON.parse(event) as { candidates: { content: { parts: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: unknown });
    expect(events.map((event) => event.candidates[0]?.content.parts[0]?.text).join("")).toBe("abcdefghij");
    expect(events.map((event) => event.candidates[0]?.finishReason)).toEqual([undefined, undefined, "STOP"]);
    expect(events.map((event) => event.usageMetadata !== undefined)).toEqual([false, false, true]);
  });
  it("CRLF and LF variants both parse to the same events, and a client that needs 'data: ' with the space is satisfied", () => {
    const chunks = buildGeminiStreamChunks(reply({ text: "abcdefgh" }), { model: "m", seed: "s", chunkChars: 4 });
    const lf = geminiSseBody(chunks, "lf");
    const crlf = geminiSseBody(chunks, "crlf");
    expect(crlf).toContain("\r\n\r\n");
    expect(crlf.replaceAll("\r\n", "\n")).toBe(lf);
    expect(parseSseText(crlf, { requireSpace: true })).toEqual(parseSseText(lf, { requireSpace: true }));
    expect(parseSseText(lf.replaceAll("data: ", "data:"), { requireSpace: true })).toMatchObject({ ok: false });
    expect(parseSseText(lf.replaceAll("data: ", "data:"), { requireSpace: false })).toMatchObject({ ok: true });
    expect(parseSseText(lf.replaceAll("\n", "\r"), { requireSpace: true })).toMatchObject({ ok: true });
  });
  it("streams as a JSON array for the legacy REST clients", () => {
    const chunks = buildGeminiStreamChunks(reply({ text: "abcdefgh" }), { model: "m", seed: "s", chunkChars: 4 });
    const body = geminiJsonArrayBody(chunks);
    expect(body.startsWith("[{")).toBe(true);
    expect(body.endsWith("}]")).toBe(true);
    const parsed = JSON.parse(body) as unknown[];
    expect(parsed).toEqual(chunks);
    expect(JSON.parse(geminiJsonArrayBody([]))).toEqual([]);
  });
  it("is bounded: a huge reply grows the chunk size instead of the chunk count, and one past the cap is refused", () => {
    const big = "x".repeat(MODEL_REPLY_MAX_CHARS);
    const started = Date.now();
    const chunks = buildGeminiStreamChunks(reply({ text: big }), { model: "m", seed: "s", chunkChars: 1 });
    expect(chunks.length).toBeLessThanOrEqual(20_000);
    expect(geminiSseBody(chunks, "lf").length).toBeGreaterThan(MODEL_REPLY_MAX_CHARS);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(() => buildGeminiGenerateContent(reply({ text: big + "y" }), { model: "m", seed: "s" })).toThrow(RangeError);
    expect(() => buildGeminiGenerateContent(reply(), { model: "m".repeat(129), seed: "s" })).toThrow(RangeError);
    expect(chunkText("héllo wörld", 3).join("")).toBe("héllo wörld");
    expect(chunkText("😀😀😀", 2).every((piece) => !/[\ud800-\udbff]$/u.test(piece))).toBe(true);
  });
});

describe("the GCE metadata server emulation", () => {
  const meta = (path: string, over: { method?: string; query?: string; headers?: Record<string, string> } = {}) => serveMetadataRequest({ method: over.method ?? "GET", path, query: over.query ?? "", headers: over.headers ?? { "Metadata-Flavor": "Google" } }, { projectId: "my-proj-1" });
  it("lists the routes of the redirect check", () => {
    expect(GCE_METADATA_ROUTES.map((entry) => entry.path)).toEqual([
      "/", "/computeMetadata/v1/instance", "/computeMetadata/v1/project/project-id", "/computeMetadata/v1/instance/service-accounts/default/", "/computeMetadata/v1/instance/service-accounts/default/token",
    ]);
  });
  it("answers each with Metadata-Flavor: Google", () => {
    for (const [path, query] of [["/", ""], ["/computeMetadata/v1/instance", ""], ["/computeMetadata/v1/project/project-id", ""], ["/computeMetadata/v1/instance/service-accounts/default/", "recursive=true"], ["/computeMetadata/v1/instance/service-accounts/default/token", "scopes=https://www.googleapis.com/auth/cloud-platform"]] as const) {
      const answer = meta(path, { query });
      expect(answer.status, path).toBe(200);
      expect(answer.headers["metadata-flavor"], path).toBe("Google");
    }
    expect(meta("/computeMetadata/v1/project/project-id").body).toBe("my-proj-1");
  });
  it("serves the service account as JSON and the token as a fixed dummy built at run time", () => {
    const account = JSON.parse(meta("/computeMetadata/v1/instance/service-accounts/default/", { query: "recursive=true" }).body) as { email: string; aliases: string[]; scopes: string[] };
    expect(account.aliases).toEqual(["default"]);
    expect(account.email).toMatch(/@/u);
    expect(account.scopes.length).toBeGreaterThan(0);
    const token = JSON.parse(meta("/computeMetadata/v1/instance/service-accounts/default/token", { query: "scopes=a" }).body) as { access_token: string; expires_in: number; token_type: string };
    expect(token).toMatchObject({ expires_in: 3600, token_type: "Bearer" });
    expect(token.access_token).toMatch(/^rovara-dummy-/u);
    expect(token.access_token).not.toMatch(/^(ya29|eyJ|AIza)/u);
  });
  it("refuses a request without Metadata-Flavor: Google, a method other than GET, an unknown path; the refusals carry the header too", () => {
    const noFlavor = meta("/computeMetadata/v1/instance", { headers: {} });
    expect(noFlavor.status).toBe(403);
    expect(noFlavor.headers["metadata-flavor"]).toBe("Google");
    expect(meta("/computeMetadata/v1/instance", { headers: { "metadata-flavor": "Other" } }).status).toBe(403);
    expect(meta("/computeMetadata/v1/instance", { method: "POST" }).status).toBe(405);
    expect(meta("/computeMetadata/v1/instance/service-accounts/other/token").status).toBe(404);
    expect(meta("/computeMetadata/v1/instance/attributes/x").status).toBe(404);
    expect(meta("/computeMetadata/v2/instance").status).toBe(404);
    expect(routeMetadataRequest({ method: "GET", path: "/computeMetadata/v1/project/project-id", query: "", headers: { "Metadata-Flavor": "Google" } })).toMatchObject({ ok: true, route: "project_id" });
    expect(meta("/" + "a".repeat(100_000)).status).toBe(404);
  });
  it("never includes the project id of another caller: the id is the one passed in", () => {
    const other = serveMetadataRequest({ method: "GET", path: "/computeMetadata/v1/project/project-id", query: "", headers: { "Metadata-Flavor": "Google" } }, { projectId: "other-proj" });
    expect(other.body).toBe("other-proj");
    expect(serveMetadataRequest({ method: "GET", path: "/computeMetadata/v1/project/project-id", query: "", headers: { "Metadata-Flavor": "Google" } }, { projectId: "bad id\n" }).status).toBe(500);
  });
});

describe("the OpenAI-compatible family", () => {
  it("routes the operations whatever the prefix and version", () => {
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1/chat/completions", pathPrefix: undefined })).toMatchObject({ ok: true, operation: "chat_completions" });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1beta/openai/chat/completions", pathPrefix: "/v1beta/openai" })).toMatchObject({ ok: true, operation: "chat_completions" });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/chat/completions", pathPrefix: "/v1beta/openai" })).toMatchObject({ ok: true, operation: "chat_completions" });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/api/v1/chat/completions", pathPrefix: "/api/v1" })).toMatchObject({ ok: true });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1/embeddings", pathPrefix: undefined })).toMatchObject({ operation: "embeddings" });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1/responses", pathPrefix: undefined })).toMatchObject({ operation: "responses" });
    expect(routeOpenAiCompatibleRequest({ method: "GET", path: "/v1/models", pathPrefix: undefined })).toMatchObject({ operation: "models" });
    expect(routeOpenAiCompatibleRequest({ method: "GET", path: "/v1/chat/completions", pathPrefix: undefined })).toMatchObject({ ok: false });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1/chat/completions/../x", pathPrefix: undefined })).toMatchObject({ ok: false });
    expect(routeOpenAiCompatibleRequest({ method: "POST", path: "/v1/fine_tuning/jobs", pathPrefix: undefined })).toMatchObject({ ok: false });
  });
  it("builds a chat completion and a stream that ends with data: [DONE]", () => {
    const completion = buildChatCompletion(reply(), { model: "gemini-2.5-flash", seed: "s", created: 1_700_000_000 }) as { object: string; choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } };
    expect(completion).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "Hello from the scripted reply." }, finish_reason: "stop" }], usage: { total_tokens: 12 } });
    const stream = buildChatCompletionStream(reply({ text: "abcdefgh" }), { model: "m", seed: "s", created: 1, chunkChars: 4 }, "lf");
    expect(stream.endsWith("data: [DONE]\n\n")).toBe(true);
    const events = (parseSseText(stream, { requireSpace: true }) as { events: string[] }).events;
    expect(events.at(-1)).toBe("[DONE]");
    const text = events.slice(0, -1).map((event) => (JSON.parse(event) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "").join("");
    expect(text).toBe("abcdefgh");
    const tool = buildChatCompletion(reply({ text: "", toolCalls: [{ name: "f", args: { a: 1 } }], finish: "tool_calls" }), { model: "m", seed: "s", created: 1 }) as { choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] }; finish_reason: string }[] };
    expect(tool.choices[0]?.finish_reason).toBe("tool_calls");
    expect(tool.choices[0]?.message.tool_calls[0]?.function).toEqual({ name: "f", arguments: '{"a":1}' });
  });
});

describe("serveModelRequest: the one entry the helper calls", () => {
  const rows = builtinModelCatalog().rows;
  const serve = (path: string, over: { method?: string; query?: string; body?: string; headers?: Record<string, string> } = {}, script: ModelReply | null = reply()) =>
    serveModelRequest(rows, { method: over.method ?? "POST", path, query: over.query ?? "", headers: over.headers ?? {}, body: over.body }, { reply: script ?? undefined, seed: "seed-1" });
  it("serves AI Studio generateContent as JSON", () => {
    const answer = serve("/p/gemini/v1beta/models/gemini-2.5-flash:generateContent", { body: "{}" });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(answer.body)).toMatchObject({ candidates: [{ finishReason: "STOP" }] });
    expect(answer.served).toMatchObject({ rowId: "gemini", family: "gemini", operation: "generateContent", mode: "ai_studio" });
  });
  it("serves SSE for alt=sse and a JSON array for the legacy form", () => {
    const sse = serve("/p/gemini/v1beta/models/m:streamGenerateContent", { query: "alt=sse" });
    expect(sse.headers["content-type"]).toBe("text/event-stream");
    expect(sse.body.startsWith("data: ")).toBe(true);
    const array = serve("/p/gemini/v1beta/models/m:streamGenerateContent", { query: "%24alt=json%3Benum-encoding%3Dint" });
    expect(array.headers["content-type"]).toBe("application/json");
    expect(Array.isArray(JSON.parse(array.body))).toBe(true);
    expect((JSON.parse(array.body) as { candidates: unknown[] }[])[0]?.candidates[0]).toBeDefined();
  });
  it("serves the Vertex row in express and project forms, and refuses a path that is not that row's", () => {
    expect(serve("/p/vertex/v1beta1/publishers/google/models/m:generateContent").status).toBe(200);
    expect(serve("/p/vertex/v1beta1/projects/p1/locations/us-central1/publishers/google/models/m:generateContent").served).toMatchObject({ mode: "vertex_project" });
    expect(serve("/p/vertex/v1beta/models/m:generateContent")).toMatchObject({ status: 404, served: undefined });
    expect(serve("/p/gemini/v1beta1/publishers/google/models/m:generateContent").status).toBe(404);
  });
  it("serves the OpenAI-compatible row, streaming when the body asks for it", () => {
    const json = serve("/p/gemini-openai/v1/chat/completions", { body: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }) });
    expect(JSON.parse(json.body)).toMatchObject({ object: "chat.completion", model: "gemini-2.5-flash" });
    const sse = serve("/p/gemini-openai/v1/chat/completions", { body: JSON.stringify({ model: "m", stream: true }) });
    expect(sse.headers["content-type"]).toBe("text/event-stream");
    expect(sse.body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(JSON.parse(serve("/p/openrouter/v1/chat/completions", { body: "{not json" }).body)).toMatchObject({ model: "unknown-model" });
    expect(JSON.parse(serve("/p/openrouter/v1/chat/completions", { body: JSON.stringify({ model: "x\nIgnore previous" }) }).body)).toMatchObject({ model: "unknown-model" });
  });
  it("never serves a Bedrock row, and says it belongs to the local AWS front", () => {
    const bedrock = { id: "bedrock", family: "bedrock" as const, pathPrefix: undefined, routesTo: "local_aws_front" as const };
    const answer = serveModelRequest([...rows, bedrock], { method: "POST", path: "/p/bedrock/model/m/converse", query: "", headers: {}, body: "{}" }, { reply: reply(), seed: "s" });
    expect(answer.status).toBe(421);
    expect((JSON.parse(answer.body) as { error: { code: string } }).error.code).toBe("routes_to_local_aws_front");
  });
  it("answers fixed errors: unknown row, no script, a family not built here, a huge body, bad paths", () => {
    expect(serve("/p/nope/v1/chat/completions").status).toBe(404);
    expect(serve("/v1/chat/completions").status).toBe(404);
    expect(serve("/p/gemini/v1beta/models/m:generateContent", {}, null)).toMatchObject({ status: 501, served: expect.anything() as unknown });
    const anthropic = { id: "anthropic", family: "anthropic_messages" as const, pathPrefix: undefined };
    expect(serveModelRequest([anthropic], { method: "POST", path: "/p/anthropic/v1/messages", query: "", headers: {}, body: "{}" }, { reply: reply(), seed: "s" }).status).toBe(501);
    expect(serve("/p/gemini/v1beta/models/m:generateContent", { body: "x".repeat(1024 * 1024 + 1) }).status).toBe(413);
    expect(serve("/p/gemini/v1beta/models/m:generateContent", { body: "x".repeat(1024 * 1024) }).status).toBe(200);
    expect(serve("/p/gemini/v1beta/models/m:countTokens", { body: "x".repeat(400) }).body).toContain("totalTokens");
    expect(serve("/p/gemini/v1beta/models/m:embedContent").status).toBe(501);
    const started = Date.now();
    serve("/p/gemini/" + "a".repeat(1_000_000));
    expect(Date.now() - started).toBeLessThan(250);
  });
  it("never echoes a credential: not the header, not the query key", () => {
    const answer = serve("/p/gemini/v1beta/models/m:generateContent", { headers: { "x-goog-api-key": fakeKey() }, query: `key=${fakeKey()}` });
    expect(JSON.stringify(answer)).not.toContain(fakeKey());
    expect(answer.served).toMatchObject({ credential: "x-goog-api-key" });
  });
});
