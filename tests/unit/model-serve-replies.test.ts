// TE-F2 part A: `serveModelRequestWithReplies`: a reply from the reply set plugs into F0a's `serveModelRequest` for Gemini, Vertex and OpenAI chat and into this lane's builders for the rest; unmatched fails closed; the
// failure pack answers after `afterCalls` and never counts; provenance decides what counts; a Bedrock row is not run here. Pure: a socket or fetch fails the test.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- these tests walk parsed JSON answers (`json()` returns any on purpose) */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SERVE_STATE, UNMATCHED_STATUS, serveModelRequestWithReplies, type ServeRepliesOptions, type ServeRepliesResult, type ServeState } from "../../packages/contracts/src/model-serve-replies.js";
import { ModelReplySetSchema } from "../../packages/contracts/src/model-reply-set.js";
import { serveModelRequest, type ModelHelperRequest } from "../../packages/contracts/src/model-serve.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import { BEDROCK_NOT_RUN_SENTENCE, UNMATCHED_SENTENCE } from "../../packages/contracts/src/model-served-family.js";
import { MODEL_REQUEST_BODY_MAX_BYTES } from "../../packages/contracts/src/model-family-common.js";
import { readModelRequestFacts } from "../../packages/contracts/src/model-request-facts.js";

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

const rows = [
  ...builtinModelCatalog().rows,
  { id: "bedrock-test", family: "bedrock" as const, routesTo: "local_aws_front" as const },
];
const fakeKey = () => ["fake", "key", String(98765)].join("-"); // built at run time; matches no real key shape
const stamp = (family: string, replies: Record<string, unknown>[]) => ModelReplySetSchema.parse({ version: 1, family, replies: replies.map((reply) => ({ provenance: "before_task", origin: "customer_written", match: {}, response: { text: `answer ${String(reply.id)}`, finish: "stop" }, ...reply })) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}, query = ""): ModelHelperRequest => ({ method: "POST", path, query, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const serve = (request: ModelHelperRequest, set: ReturnType<typeof stamp> | undefined, over: Partial<ServeRepliesOptions> = {}): ServeRepliesResult => serveModelRequestWithReplies(rows, set, request, { seed: "seed-1", ...over });
const json = (result: ServeRepliesResult): any => JSON.parse(result.answer.body); // eslint-disable-line @typescript-eslint/no-explicit-any

const OPENAI_BODY = { model: "gpt-test", messages: [{ role: "user", content: "what is the weather in Paris" }] };
const ANTHROPIC_BODY = { model: "claude-test", max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "what is the weather in Paris" }] }] };

describe("scripted answers per family", () => {
  it("OpenAI chat: F0a's own bytes for the chosen reply (parity with serveModelRequest)", () => {
    const set = stamp("openai_compatible", [{ id: "a", response: { text: "Sunny.", finish: "stop", usage: { inputTokens: 3, outputTokens: 2 } } }]);
    const result = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY, { authorization: `Bearer ${fakeKey()}` }), set);
    expect(result).toMatchObject({ kind: "scripted", resultClass: "before_task", countsTowardProof: true, rowId: "openai", family: "openai_compatible", operation: "chat_completions", model: "gpt-test", credential: "authorization", replyId: "a", provenance: "before_task" });
    const f0a = serveModelRequest(rows, post("/p/openai/v1/chat/completions", OPENAI_BODY), { reply: { text: "Sunny.", finish: "stop", usage: { inputTokens: 3, outputTokens: 2 } }, seed: "seed-1" });
    expect(result.answer).toEqual({ status: f0a.status, headers: f0a.headers, body: f0a.body });
    expect(json(result).choices[0].message.content).toBe("Sunny.");
  });
  it("OpenAI chat streamed ends with [DONE]", () => {
    const set = stamp("openai_compatible", [{ id: "a" }]);
    const result = serve(post("/p/openai/v1/chat/completions", { ...OPENAI_BODY, stream: true }), set);
    expect(result.answer.headers["content-type"]).toBe("text/event-stream");
    expect(result.answer.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });
  it("Gemini generateContent, SSE and JSON array: F0a's bytes", () => {
    const set = stamp("gemini", [{ id: "g" }]);
    const reply = { text: "answer g", finish: "stop" as const };
    for (const [path, query] of [["/p/gemini/v1beta/models/gemini-2.5-flash:generateContent", ""], ["/p/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent", "alt=sse"], ["/p/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent", "$alt=json;enum-encoding=int"]] as const) {
      const request = post(path, { contents: [{ parts: [{ text: "hi" }] }] }, { "x-goog-api-key": fakeKey() }, query);
      const result = serve(request, set);
      const f0a = serveModelRequest(rows, request, { reply, seed: "seed-1" });
      expect(result.kind, path + query).toBe("scripted");
      expect(result.credential).toBe("x-goog-api-key");
      expect(result.answer, path + query).toEqual({ status: f0a.status, headers: f0a.headers, body: f0a.body });
    }
  });
  it("Vertex project mode and Gemini's OpenAI endpoint", () => {
    const vertex = serve(post("/p/vertex/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent", {}), stamp("vertex", [{ id: "v" }]));
    expect(vertex).toMatchObject({ kind: "scripted", family: "vertex", operation: "generateContent", model: "gemini-2.5-flash" });
    const compat = serve(post("/p/gemini-openai/v1beta/openai/chat/completions", OPENAI_BODY), stamp("openai_compatible", [{ id: "o" }]));
    expect(compat).toMatchObject({ kind: "scripted", family: "openai_compatible", operation: "chat_completions" });
    const viaGemini = serve(post("/p/gemini/v1beta/openai/chat/completions", OPENAI_BODY), stamp("gemini", [{ id: "o" }]));
    expect(viaGemini.kind).toBe("scripted");
    expect(json(viaGemini).object).toBe("chat.completion");
  });
  it("OpenAI Responses and embeddings (the Python SDK's base64 default)", () => {
    const set = stamp("openai_compatible", [{ id: "r", match: { operation: "responses" } }, { id: "e", match: { operation: "embeddings" } }]);
    const response = serve(post("/p/openai/v1/responses", { model: "gpt-test", input: "hello" }), set);
    expect(response).toMatchObject({ kind: "scripted", operation: "responses", replyId: "r" });
    expect(json(response).output[0].content[0].text).toBe("answer r");
    const embed = serve(post("/p/openai/v1/embeddings", { model: "te", input: ["a", "b"], encoding_format: "base64", dimensions: 8 }), set);
    expect(embed).toMatchObject({ kind: "scripted", operation: "embeddings", replyId: "e" });
    expect(json(embed).data).toHaveLength(2);
    expect(typeof json(embed).data[0].embedding).toBe("string");
    expect(Buffer.from(json(embed).data[0].embedding, "base64").byteLength).toBe(32);
  });
  it("Anthropic messages (whole and streamed) and count_tokens", () => {
    const set = stamp("anthropic_messages", [{ id: "m", match: { operation: "messages" } }, { id: "c", match: { operation: "count_tokens" } }]);
    const whole = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY, { "x-api-key": fakeKey(), "anthropic-version": "2023-06-01" }), set);
    expect(whole).toMatchObject({ kind: "scripted", family: "anthropic_messages", operation: "messages", model: "claude-test", credential: "x-api-key" });
    expect(json(whole)).toMatchObject({ type: "message", role: "assistant", model: "claude-test", stop_reason: "end_turn" });
    const streamed = serve(post("/p/anthropic/v1/messages", { ...ANTHROPIC_BODY, stream: true }), set);
    expect(streamed.answer.headers["content-type"]).toBe("text/event-stream");
    expect(streamed.answer.body.startsWith("event: message_start\n")).toBe(true);
    expect(streamed.answer.body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
    const count = serve(post("/p/anthropic/v1/messages/count_tokens", ANTHROPIC_BODY), set);
    expect(count).toMatchObject({ kind: "scripted", operation: "count_tokens", replyId: "c" });
    expect(json(count).input_tokens).toBeGreaterThan(0);
    expect(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY, {}, "beta=true"), set).kind).toBe("scripted"); // the SDK's ?beta=true is a query, not part of the path
    expect(serve(post("/p/anthropic/v1/messages?beta=true", ANTHROPIC_BODY), set).kind).toBe("not_served"); // a query inside the path is refused
  });
  it("Cohere chat, embed and rerank", () => {
    const set = stamp("cohere", [{ id: "c", match: { operation: "chat" } }, { id: "e", match: { operation: "embed" } }, { id: "r", match: { operation: "rerank" } }]);
    const chat = serve(post("/p/cohere/v2/chat", { model: "command-r", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${fakeKey()}` }), set);
    expect(chat).toMatchObject({ kind: "scripted", family: "cohere", operation: "chat", model: "command-r" });
    expect(json(chat).message.content[0].text).toBe("answer c");
    const embed = serve(post("/p/cohere/v2/embed", { model: "embed-v4", texts: ["a", "b", "c"], embedding_types: ["float"], input_type: "search_document", output_dimension: 6 }), set);
    expect(json(embed).embeddings.float).toHaveLength(3);
    expect(json(embed).embeddings.float[0]).toHaveLength(6);
    const rerank = serve(post("/p/cohere/v2/rerank", { model: "rerank-v3.5", query: "q", documents: ["a", "b", "c"], top_n: 2 }), set);
    expect(json(rerank).results).toHaveLength(2);
    const streamed = serve(post("/p/cohere/v2/chat", { model: "command-r", stream: true, messages: [] }), set);
    expect(streamed.answer.body.startsWith("event: message-start\n")).toBe(true);
  });
  it("Gemini embedContent and batchEmbedContents", () => {
    const set = stamp("gemini", [{ id: "e", match: { operation: "embedContent" } }, { id: "b", match: { operation: "batchEmbedContents" } }]);
    const one = serve(post("/p/gemini/v1beta/models/text-embedding-004:embedContent", { content: { parts: [{ text: "hi" }] }, outputDimensionality: 5 }), set);
    expect(one).toMatchObject({ kind: "scripted", operation: "embedContent" });
    expect(json(one).embedding.values).toHaveLength(5);
    const batch = serve(post("/p/gemini/v1beta/models/text-embedding-004:batchEmbedContents", { requests: [{ content: { parts: [{ text: "a" }] }, outputDimensionality: 4 }, { content: { parts: [{ text: "b" }] } }] }), set);
    expect(batch).toMatchObject({ kind: "scripted", operation: "batchEmbedContents" });
    expect(json(batch).embeddings).toHaveLength(2);
    expect(json(batch).embeddings[0].values).toHaveLength(4);
  });
  it("Azure OpenAI: a deployment path on the suffix row", () => {
    const result = serve(post("/p/azure-openai/openai/deployments/my-dep/chat/completions", OPENAI_BODY, { "api-key": fakeKey() }, "api-version=2024-06-01"), stamp("openai_compatible", [{ id: "z" }]));
    expect(result).toMatchObject({ kind: "scripted", rowId: "azure-openai", operation: "chat_completions", credential: "api-key" });
  });
  it("never echoes a credential, and a deterministic seed gives the same bytes", () => {
    const key = fakeKey();
    const set = stamp("anthropic_messages", [{ id: "m" }]);
    const result = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY, { "x-api-key": key, authorization: `Bearer ${key}` }), set);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set).answer).toEqual(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set).answer);
  });
});

describe("unmatched fails closed", () => {
  it("answers a fixed 400 in the family's own shape and never invents a reply", () => {
    const empty = stamp("anthropic_messages", []);
    const result = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), empty);
    expect(UNMATCHED_STATUS).toBe(400);
    expect(result).toMatchObject({ kind: "unmatched", resultClass: "unmatched", countsTowardProof: false, replyId: undefined, provenance: undefined, replySha256: undefined, evidenceSentence: UNMATCHED_SENTENCE, rowId: "anthropic", operation: "messages" });
    expect(result.answer.status).toBe(400);
    expect(json(result)).toEqual({ type: "error", error: { type: "invalid_request_error", message: "not run: no scripted reply for this request" } });
    const openai = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), undefined);
    expect(json(openai).error).toMatchObject({ type: "invalid_request_error", code: "no_scripted_reply", message: "not run: no scripted reply for this request" });
    expect(json(serve(post("/p/gemini/v1beta/models/m:generateContent", {}), undefined)).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    expect(json(serve(post("/p/cohere/v2/chat", {}), undefined))).toEqual({ message: "not run: no scripted reply for this request" });
  });
  it("is counted: the call count advances, the reply counts do not name a reply", () => {
    const result = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), stamp("openai_compatible", [{ id: "x", match: { promptContains: "never" } }]));
    expect(result.nextState.callCount).toBe(1);
    expect(result.kind).toBe("unmatched");
  });
  it("a set for another family matches nothing", () => {
    expect(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), stamp("gemini", [{ id: "a" }])).kind).toBe("unmatched");
  });
  it("a reply that names another model or operation does not match", () => {
    const set = stamp("openai_compatible", [{ id: "a", match: { model: "other-model" } }, { id: "b", match: { operation: "embeddings" } }]);
    expect(serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), set).kind).toBe("unmatched");
  });
  it("matches on the prompt text, system and tool-free fields only", () => {
    const set = stamp("anthropic_messages", [{ id: "weather", match: { promptContains: "weather in Paris" } }, { id: "system", match: { promptContains: "Be brief." } }, { id: "role", match: { promptContains: "user" } }, { id: "tool", match: { promptContains: "get_weather" } }]);
    expect(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set).replyId).toBe("weather");
    expect(serve(post("/p/anthropic/v1/messages", { ...ANTHROPIC_BODY, messages: [{ role: "user", content: "hi" }] }), set).replyId).toBe("system");
    expect(serve(post("/p/anthropic/v1/messages", { model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "get_weather", description: "weather in Paris", input_schema: {} }] }), set).kind).toBe("unmatched");
  });
});

describe("provenance decides what counts", () => {
  it("before_task and independent count; task_made does not", () => {
    const set = stamp("openai_compatible", [
      { id: "b", match: { promptContains: "one" } },
      { id: "i", match: { promptContains: "two" }, provenance: "independent", origin: undefined },
      { id: "t", match: { promptContains: "three" }, provenance: "task_made", origin: undefined },
    ]);
    const call = (word: string) => serve(post("/p/openai/v1/chat/completions", { model: "m", messages: [{ role: "user", content: word }] }), set);
    expect(call("one")).toMatchObject({ kind: "scripted", resultClass: "before_task", countsTowardProof: true });
    expect(call("two")).toMatchObject({ kind: "scripted", resultClass: "independent", countsTowardProof: true });
    expect(call("three")).toMatchObject({ kind: "scripted", resultClass: "task_made", countsTowardProof: false, provenance: "task_made" });
  });
  it("records a content hash, never the reply", () => {
    const result = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), stamp("openai_compatible", [{ id: "a", response: { text: "a secret answer", finish: "stop" } }]));
    expect(result.replySha256).toMatch(/^[0-9a-f]{64}$/u);
    const ledger: Record<string, unknown> = { ...result };
    delete ledger.answer;
    expect(JSON.stringify(ledger)).not.toContain("a secret answer");
    expect(JSON.stringify(ledger)).not.toContain("weather in Paris");
  });
});

describe("sequence and state", () => {
  it("the nth matching call picks the nth reply, then nothing", () => {
    const set = stamp("openai_compatible", [{ id: "first", match: { sequence: 1 } }, { id: "second", match: { sequence: 2 } }]);
    let state: ServeState = INITIAL_SERVE_STATE;
    const seen: (string | undefined)[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), set, { state });
      seen.push(result.replyId);
      state = result.nextState;
    }
    expect(seen).toEqual(["first", "second", undefined]);
    expect(state.callCount).toBe(3);
    expect(INITIAL_SERVE_STATE.callCount).toBe(0);
    expect(INITIAL_SERVE_STATE.matchCounts.size).toBe(0);
  });
});

describe("the failure pack", () => {
  it("answers from the first call by default, is class failure_pack and never counts", () => {
    const set = stamp("openai_compatible", [{ id: "a" }]);
    const result = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), set, { failure: { mode: "rate_limit" } });
    expect(result).toMatchObject({ kind: "failure_pack", resultClass: "failure_pack", countsTowardProof: false, failureMode: "rate_limit", replyId: undefined, provenance: undefined });
    expect(result.answer.status).toBe(429);
  });
  it("afterCalls: the first n calls succeed from the reply set, then the failure starts", () => {
    const set = stamp("anthropic_messages", [{ id: "a" }]);
    let state: ServeState = INITIAL_SERVE_STATE;
    const kinds: string[] = [];
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set, { failure: { mode: "rate_limit", afterCalls: 2 }, state });
      kinds.push(result.kind);
      statuses.push(result.answer.status);
      state = result.nextState;
    }
    expect(kinds).toEqual(["scripted", "scripted", "failure_pack", "failure_pack"]);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
  it("M2: in a failure-pack run NO call counts toward proof, including the calls before afterCalls", () => {
    const set = stamp("anthropic_messages", [{ id: "a" }]);
    let state: ServeState = INITIAL_SERVE_STATE;
    const rowsOfRun: [string, boolean, string | undefined][] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set, { failure: { mode: "rate_limit", afterCalls: 2 }, state });
      rowsOfRun.push([result.kind, result.countsTowardProof, result.provenance]);
      state = result.nextState;
    }
    expect(rowsOfRun).toEqual([["scripted", false, "before_task"], ["scripted", false, "before_task"], ["failure_pack", false, undefined], ["failure_pack", false, undefined]]);
    // the same calls with no failure spec do count
    expect(serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), set).countsTowardProof).toBe(true);
  });
  it("a failure answer is never counted even when a counted reply exists for the call", () => {
    const set = stamp("openai_compatible", [{ id: "a" }]);
    for (const mode of ["rate_limit", "cut_off_stream", "token_limit", "refusal", "bad_tool_json"] as const) {
      const result = serve(post("/p/openai/v1/chat/completions", { ...OPENAI_BODY, stream: true, tools: [{ type: "function", function: { name: "lookup" } }] }), set, { failure: { mode } });
      expect(result.countsTowardProof, mode).toBe(false);
      expect(result.resultClass, mode).toBe("failure_pack");
      expect(result.kind, mode).toBe("failure_pack");
    }
  });
  it("uses the declared tool and the streaming flag of the request", () => {
    const result = serve(post("/p/openai/v1/chat/completions", { ...OPENAI_BODY, tools: [{ type: "function", function: { name: "lookup_order" } }] }), undefined, { failure: { mode: "bad_tool_json" } });
    expect(result.answer.body).toContain('"name":"lookup_order"');
    const gemini = serve(post("/p/gemini/v1beta/models/m:streamGenerateContent", {}, {}, "alt=sse"), undefined, { failure: { mode: "cut_off_stream" } });
    expect(gemini.answer.body.endsWith("\n\n")).toBe(false);
  });
  it("a failure needs no reply set", () => {
    expect(serve(post("/p/cohere/v2/chat", { stream: true }), undefined, { failure: { mode: "cut_off_stream" } }).kind).toBe("failure_pack");
  });
});

describe("requests that are not served", () => {
  it("Bedrock: not run here, answered with the fixed sentence", () => {
    const result = serve(post("/p/bedrock-test/model/x/converse", {}), undefined);
    expect(result).toMatchObject({ kind: "not_served", resultClass: "not_served", countsTowardProof: false, evidenceSentence: BEDROCK_NOT_RUN_SENTENCE, rowId: "bedrock-test" });
    expect(result.answer.status).toBe(421);
    expect(json(result).error.message).toBe("not run: Bedrock scripted replies are served by the local AWS front");
    expect(serve(post("/p/bedrock-test/x", {}), undefined, { failure: { mode: "rate_limit" } }).kind).toBe("not_served"); // not even the failure pack
  });
  it("unknown rows, bad paths, wrong methods and routes that do not belong to the row", () => {
    expect(serve(post("/nope", {}), undefined)).toMatchObject({ kind: "not_served" });
    expect(serve(post("/p/missing/v1/chat/completions", {}), undefined).answer.status).toBe(404);
    expect(serve({ method: "GET", path: "/p/openai/v1/chat/completions", query: "", headers: {}, body: undefined }, undefined).answer.status).toBe(405);
    expect(serve(post("/p/anthropic/v1/chat/completions", {}), undefined).answer.status).toBe(404);
    expect(serve(post("/p/gemini/v1/projects/p/locations/l/publishers/google/models/m:generateContent", {}), undefined).answer.status).toBe(404); // a Vertex path on the AI Studio row
    for (const result of [serve(post("/nope", {}), undefined), serve(post("/p/openai/v1/nothing", {}), undefined)]) {
      expect(result.countsTowardProof).toBe(false);
      expect(result.nextState.callCount).toBe(0); // nothing reached an operation
    }
  });
  it("an operation this lane does not build is not_served, never an invented success", () => {
    const set = stamp("openai_compatible", [{ id: "a" }]);
    const models = serve({ method: "GET", path: "/p/openai/v1/models", query: "", headers: {}, body: undefined }, set);
    expect(models).toMatchObject({ kind: "not_served", countsTowardProof: false });
    expect(models.answer.status).toBe(422); // a 4xx: no SDK retries it (L2)
  });
  it("a request body past 1 MiB is refused before anything is read (F0a's own cap does not cover Anthropic or Cohere)", () => {
    for (const [path, family] of [["/p/openai/v1/chat/completions", "openai_compatible"], ["/p/anthropic/v1/messages", "anthropic_messages"], ["/p/cohere/v2/chat", "cohere"]] as const) {
      const result = serve(post(path, "x".repeat(MODEL_REQUEST_BODY_MAX_BYTES + 1)), stamp(family, [{ id: "a" }]));
      expect(result, family).toMatchObject({ kind: "not_served", countsTowardProof: false });
      expect(result.answer.status, family).toBe(413);
      expect(result.nextState.callCount, family).toBe(0);
    }
    expect(serve(post("/p/anthropic/v1/messages", "x".repeat(MODEL_REQUEST_BODY_MAX_BYTES)), stamp("anthropic_messages", [{ id: "a" }])).kind).toBe("scripted"); // exactly 1 MiB is allowed
  });
  it("a reply that cannot be rendered is a fixed 500, not a throw", () => {
    const broken = { version: 1, family: "anthropic_messages", replies: [{ id: "a", match: {}, response: { text: "x", finish: "stop", usage: { inputTokens: -5, outputTokens: 1 } }, provenance: "before_task", origin: "customer_written" }] } as never;
    const result = serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), broken);
    expect(result).toMatchObject({ kind: "not_served", countsTowardProof: false, replyId: "a" });
    expect(result.answer.status).toBe(422); // a 4xx: no SDK retries it (L2)
    expect(json(result).error.code).toBe("bad_reply");
  });
  it("L2: an answer that is not a success is never a 5xx or a 429 an SDK would retry (except a real unmatched 400 and the pack's own 429)", () => {
    const broken = { version: 1, family: "anthropic_messages", replies: [{ id: "a", match: {}, response: { text: "x", finish: "stop", usage: { inputTokens: -5, outputTokens: 1 } }, provenance: "before_task", origin: "customer_written" }] } as never;
    for (const result of [serve(post("/p/anthropic/v1/messages", ANTHROPIC_BODY), broken), serve({ method: "GET", path: "/p/openai/v1/models", query: "", headers: {}, body: undefined }, stamp("openai_compatible", [{ id: "m" }])), serve(post("/p/gemini/v1beta/models/m:rawPredict", {}), undefined)]) {
      expect(result.kind).toBe("not_served");
      expect(result.answer.status).toBeGreaterThanOrEqual(400);
      expect(result.answer.status).toBeLessThan(500);
      expect([408, 409, 429]).not.toContain(result.answer.status);
    }
    // F0a's own 500 internal_error (a reply its builder refuses) reaches the client as a 4xx too
    const f0aBroken = { version: 1, family: "openai_compatible", replies: [{ id: "a", match: {}, response: { text: "x", finish: "stop", usage: { inputTokens: -5, outputTokens: 1 } }, provenance: "before_task", origin: "customer_written" }] } as never;
    const viaF0a = serve(post("/p/openai/v1/chat/completions", OPENAI_BODY), f0aBroken);
    expect(viaF0a).toMatchObject({ kind: "not_served", countsTowardProof: false });
    expect(viaF0a.answer.status).toBe(422);
    expect(json(viaF0a).error.code).toBe("internal_error");
    expect(serveModelRequestWithReplies([{ id: "x", family: "nope" as never }], undefined, post("/p/x/y", {}), { seed: "s" }).answer.status).toBe(422);
  });
  it("a Bedrock-family row never reaches a served family even when listed as servable", () => {
    expect(serveModelRequestWithReplies([{ id: "b", family: "bedrock" }], undefined, post("/p/b/x", {}), { seed: "s" }).kind).toBe("not_served");
  });
});

describe("speed and bounds", () => {
  it("a 1 MB request is read fast", () => {
    const big = { model: "m", messages: [{ role: "user", content: "paris ".repeat(160_000) }] };
    const set = stamp("openai_compatible", [{ id: "a", match: { promptContains: "paris" } }]);
    const started = performance.now();
    const result = serve(post("/p/openai/v1/chat/completions", big), set);
    expect(result.kind).toBe("scripted");
    expect(performance.now() - started).toBeLessThan(1500);
    const facts = readModelRequestFacts(JSON.stringify(big));
    expect(facts.promptText?.length).toBeGreaterThan(900_000);
  });
  it("a 2,000-reply set is searched fast", () => {
    const set = stamp("openai_compatible", Array.from({ length: 2000 }, (_, index) => ({ id: `r${String(index)}`, match: { promptContains: `#${String(index)}#` } })));
    const started = performance.now();
    const result = serve(post("/p/openai/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "#1999#" }] }), set);
    expect(result.replyId).toBe("r1999");
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("M3: embedding requests are capped before anything is built", () => {
  const cohereSet = stamp("cohere", [{ id: "e", provenance: "task_made", origin: undefined }]);
  const openaiSet = stamp("openai_compatible", [{ id: "e", provenance: "task_made", origin: undefined }]);
  const geminiSet = stamp("gemini", [{ id: "e", provenance: "task_made", origin: undefined }]);
  const refused = (result: ServeRepliesResult) => {
    expect(result.kind).toBe("not_served");
    expect(result.countsTowardProof).toBe(false);
    expect(result.answer.status).toBe(400);
    expect(result.answer.body.length).toBeLessThan(1000);
  };
  it("the reviewer's probe: 2,048 texts x 4,096 dimensions x six types is refused fast and small", () => {
    const started = performance.now();
    const before = process.memoryUsage().heapUsed;
    for (const types of [["float"], ["float", "int8", "uint8", "binary", "ubinary", "base64"]]) {
      refused(serve(post("/p/cohere/v2/embed", { model: "m", texts: Array.from({ length: 2048 }, () => "a"), output_dimension: 4096, embedding_types: types }), cohereSet));
    }
    refused(serve(post("/p/openai/v1/embeddings", { model: "m", input: Array.from({ length: 2048 }, () => "a"), dimensions: 4096 }), openaiSet));
    expect(performance.now() - started).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(60 * 1024 * 1024);
  });
  it("each family's own limits: Cohere 96 texts, OpenAI 3,072 dimensions, Gemini 100 batch requests", () => {
    expect(serve(post("/p/cohere/v2/embed", { model: "m", texts: Array.from({ length: 96 }, () => "a"), output_dimension: 1024 }), cohereSet).kind).toBe("scripted");
    refused(serve(post("/p/cohere/v2/embed", { model: "m", texts: Array.from({ length: 97 }, () => "a") }), cohereSet));
    expect(serve(post("/p/openai/v1/embeddings", { model: "m", input: ["a"], dimensions: 3072 }), openaiSet).kind).toBe("scripted");
    refused(serve(post("/p/openai/v1/embeddings", { model: "m", input: ["a"], dimensions: 3073 }), openaiSet));
    const batch = (count: number) => post("/p/gemini/v1beta/models/te:batchEmbedContents", { requests: Array.from({ length: count }, () => ({ content: { parts: [{ text: "a" }] } })) });
    expect(serve(batch(100), geminiSet).kind).toBe("scripted");
    refused(serve(batch(101), geminiSet));
  });
  it("a total cap on numbers: inputs x dimensions x types", () => {
    refused(serve(post("/p/openai/v1/embeddings", { model: "m", input: Array.from({ length: 300 }, () => "a"), dimensions: 3072 }), openaiSet)); // 921,600 numbers
    expect(serve(post("/p/openai/v1/embeddings", { model: "m", input: Array.from({ length: 80 }, () => "a"), dimensions: 3072 }), openaiSet).kind).toBe("scripted"); // 245,760
    refused(serve(post("/p/cohere/v2/embed", { model: "m", texts: Array.from({ length: 90 }, () => "a"), output_dimension: 1536, embedding_types: ["float", "int8"] }), cohereSet)); // 276,480
  });
  it("the refusal is a fixed answer in the family's envelope, with no RangeError and no echo of the request", () => {
    const result = serve(post("/p/openai/v1/embeddings", { model: "m", input: ["secret-input"], dimensions: 99_999 }), openaiSet);
    expect(JSON.parse(result.answer.body).error.message).toBe("not run: this embedding request is larger than the model helper serves");
    expect(result.answer.body).not.toContain("secret-input");
  });
  it("the failure pack still answers an oversized embedding (it builds nothing)", () => {
    expect(serve(post("/p/cohere/v2/embed", { texts: Array.from({ length: 2048 }, () => "a"), output_dimension: 4096 }), undefined, { failure: { mode: "rate_limit" } }).answer.status).toBe(429);
  });
});
