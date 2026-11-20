// TE-F0a: the Gemini and OpenAI-compatible family shapes: the request router on every path form of the redirect check, the response builders (JSON, SSE, JSON array), the GCE metadata route table, and the one entry the
// helper will call. Pure: a test fails if anything opens a socket or calls fetch.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GCE_METADATA_ROUTES, GEMINI_INT_ENCODING_VERIFIED, GEMINI_OPERATIONS, GEMINI_ROUTE_REFUSALS, buildGeminiGenerateContent, buildGeminiStreamChunks, geminiSseBody, routeGeminiRequest, routeMetadataRequest, serveMetadataRequest } from "../../packages/contracts/src/model-family-gemini.js";
import { parseSseText } from "../../packages/contracts/src/model-family-common.js";
import { serveModelRequest } from "../../packages/contracts/src/model-serve.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import type { ModelReply } from "../../packages/contracts/src/model-family-common.js";
import { expectLinearScaling } from "../support/scaling.js";

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
  it("accepts any API version prefix", () => {
    for (const version of ["v1", "v1beta", "v1alpha", "v1beta1", "v2", "v1beta2", "v10", "v1main"]) {
      expect(route(`/${version}/models/m:generateContent`), version).toMatchObject({ ok: true, apiVersion: version, mode: "ai_studio" });
      expect(route(`/${version}/publishers/google/models/m:generateContent`), version).toMatchObject({ ok: true, apiVersion: version, mode: "vertex_express" });
    }
    for (const version of ["", "beta", "1", "V1", "v", "v1beta1x2y3z4w5v6u", "v1/../v1"]) expect(route(`/${version}/models/m:generateContent`).ok, version).toBe(false);
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
    // The reason is part of the guard: a traversal or an encoded character is refused as a bad path, not as some other mismatch.
    expect(route("/v1beta/models/../m:generateContent")).toEqual({ ok: false, reason: "bad_path" });
    expect(route("/v1beta/models/%2e%2e:generateContent")).toEqual({ ok: false, reason: "bad_path" });
    expect(route("/v1beta/models/m%3AgenerateContent")).toEqual({ ok: false, reason: "bad_path" });
    expect(route("/v1beta//models/m:generateContent")).toEqual({ ok: false, reason: "bad_path" });
    expect(route("/v1beta/models/a b:generateContent")).toMatchObject({ ok: false });
    expect(route(`/v1beta/models/${"m".repeat(129)}:generateContent`)).toEqual({ ok: false, reason: "bad_model" });
    expect(route(`/v1beta/models/${"m".repeat(128)}:generateContent`)).toMatchObject({ ok: true });
    expect(route("/v1beta/models/:generateContent")).toEqual({ ok: false, reason: "bad_model" });
    expect(route("/v1beta/models/m:generateContent", { query: "%ZZ=1" })).toEqual({ ok: false, reason: "bad_query" });
    expect(route("/v1beta/models/m:generateContent", { query: Array.from({ length: 33 }, (_, index) => `k${String(index)}=1`).join("&") })).toEqual({ ok: false, reason: "bad_query" });
    expect(route("/v1beta/models/m:generateContent", { query: `a=${"x".repeat(3000)}` })).toEqual({ ok: false, reason: "bad_query" });
    expect(route(`/v1beta/models/m:generateContent${"x".repeat(600)}`)).toMatchObject({ ok: false });
  });
  it("accepts headers as arrays and in any case", () => {
    expect(routeGeminiRequest({ method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: { "X-GOOG-API-KEY": [fakeKey()] } })).toMatchObject({ credential: "x-goog-api-key" });
    expect(routeGeminiRequest({ method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: { Authorization: "bearer abc" } })).toMatchObject({ credential: "authorization" });
  });
});

describe("Gemini response builders", () => {
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

describe("serveModelRequest: the one entry the helper calls", () => {
  const rows = builtinModelCatalog().rows;
  const serve = (path: string, over: { method?: string; query?: string; body?: string; headers?: Record<string, string> } = {}, script: ModelReply | null = reply()) =>
    serveModelRequest(rows, { method: over.method ?? "POST", path, query: over.query ?? "", headers: over.headers ?? {}, body: over.body }, { reply: script ?? undefined, seed: "seed-1" });
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
    // Scaling check: a huge path is refused without being read (N is small so the 8N input stays in CPU cache; the old 1,000,000 characters is checked once at full size below), so the work is flat (ratio near 1); work that reads it would grow about 8 times.
    let served: { status: number } | undefined;
    const { ratio } = expectLinearScaling((size) => {
      const path = "/p/gemini/" + "a".repeat(size);
      return () => { served = serve(path); };
    }, { n: 32_000, label: "serveModelRequest on a huge path" });
    expect(ratio).toBeLessThan(3);
    expect(served?.status).toBeGreaterThanOrEqual(400);
    expect(serve("/p/gemini/" + "a".repeat(1_000_000)).status).toBeGreaterThanOrEqual(400);
  });
  it("serves the Cloudflare gateway path /v1/<account>/<gateway>/openai/... and Azure deployment paths", () => {
    const cloudflare = serve("/p/cloudflare-ai-gateway/v1/acct123/my-gw/openai/chat/completions", { body: JSON.stringify({ model: "gpt-4o" }) });
    expect(cloudflare.status).toBe(200);
    expect(cloudflare.served).toMatchObject({ rowId: "cloudflare-ai-gateway", operation: "chat_completions" });
    expect(serve("/p/azure-openai/openai/deployments/my-deploy/chat/completions", { query: "api-version=2024-10-21", body: "{}" }).status).toBe(200);
    expect(serve("/p/cloudflare-ai-gateway/v1/a/b/c/d/e/f/g/chat/completions").status).toBe(404);
    expect(serve("/p/cloudflare-ai-gateway/v1/../b/openai/chat/completions").status).toBe(404);
    expect(serve("/p/cloudflare-ai-gateway/v1/a/b/openai/fine_tuning/jobs").status).toBe(404);
  });
});
