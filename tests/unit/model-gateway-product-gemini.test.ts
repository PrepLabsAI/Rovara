import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type https from "node:https";
import { createGeminiTransport, GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, GeminiUsageCollector, geminiUsage, guardGemini, parseGeminiPath, PRODUCT_AUDIO_REFUSED, PRODUCT_MEDIA_FILE_REFUSED, PRODUCT_TOOL_REFUSED } from "../../packages/model-gateway/src/product-gemini.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import type { ModelLimitsSource } from "../../packages/model-gateway/src/guard.js";
import { PRODUCT_BRIDGE } from "../../packages/model-gateway/src/product-bridge.js";

const path = parseGeminiPath("/v1/product/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent", "alt=sse")!;
const limits = { maxOutputTokens: () => 1000 };
const headers = { "content-type": "application/json", "x-api-key": "token" };
const guard = (body: unknown, h: Record<string, string> = headers, l: ModelLimitsSource = limits) => guardGemini(Buffer.from(JSON.stringify(body)), h, path, l);
const text = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

describe("Gemini path parsing", () => {
  it("accepts only the two methods, known versions, a plain model id, and alt=sse for streaming", () => {
    expect(path).toEqual({ version: "v1beta", model: "gemini-2.5-pro", streaming: true });
    expect(parseGeminiPath("/v1/product/gemini/v1/models/gemini-2.0-flash-001:generateContent", "")).toEqual({ version: "v1", model: "gemini-2.0-flash-001", streaming: false });
    for (const [p, q] of [
      ["/v1/product/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent", ""],
      ["/v1/product/gemini/v1beta/models/gemini-2.5-pro:generateContent", "key=abc"],
      ["/v1/product/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent", "alt=sse&key=abc"],
      ["/v1/product/gemini/v2/models/gemini-2.5-pro:generateContent", ""],
      ["/v1/product/gemini/v1beta/models/../x:generateContent", ""],
      ["/v1/product/gemini/v1beta/models/Gemini:generateContent", ""],
      ["/v1/product/gemini/v1beta/models/gemini-2.5-pro:countTokens", ""],
      ["/v1/product/gemini/v1beta/tunedModels/x:generateContent", ""],
    ] as const) expect(parseGeminiPath(p, q)).toBeUndefined();
  });
});

describe("Gemini guard", () => {
  it("sets maxOutputTokens to the row's own max when absent, keeps a smaller one, refuses a bigger one", () => {
    const a = guard(text); if (!a.ok) throw new Error("guard");
    expect((JSON.parse(a.bytes.toString()) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(1000); expect(a.maxTokens).toBe(1000);
    expect(a.path).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"); expect(a.headers).toEqual({ "content-type": "application/json" });
    const b = guard({ ...text, generationConfig: { maxOutputTokens: 10 } }); expect(b.ok && b.maxTokens).toBe(10);
    expect(guard({ ...text, generationConfig: { maxOutputTokens: 1001 } }).ok).toBe(false);
  });
  it("an unknown model limit uses the documented default instead of refusing (DEC 172)", () => {
    const r = guard(text, headers, { maxOutputTokens: (): unknown => undefined }); expect(r.ok && r.maxTokens).toBe(GEMINI_DEFAULT_MAX_OUTPUT_TOKENS);
    const t = guard(text, headers, { maxOutputTokens: () => { throw new Error("x"); } }); expect(t.ok && t.maxTokens).toBe(GEMINI_DEFAULT_MAX_OUTPUT_TOKENS);
  });
  it("text and function declarations are bounded; any media part, cachedContent or fileData is overrun-capable (REVIEW-1 H1)", () => {
    const ok = guard({ contents: [{ parts: [{ text: "a" }] }], tools: [{ functionDeclarations: [{ name: "f" }] }] });
    expect(ok.ok && ok.inputBounded).toBe(true); expect(ok.ok && ok.hasTools).toBe(true);
    for (const media of [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { inlineData: { mimeType: "application/pdf", data: "AAAA" } }]) {
      const r = guard({ contents: [{ parts: [{ text: "a" }, media] }] }); expect(r.ok && r.inputBounded).toBe(false);
    }
    const cached = guard({ ...text, cachedContent: "cachedContents/abc" }); expect(cached.ok && cached.inputBounded).toBe(false);
    const file = guard({ contents: [{ parts: [{ fileData: { mimeType: "image/png", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/x" } }] }] }); expect(file.ok && file.inputBounded).toBe(false);
  });
  it("media nested at any depth (functionResponse.parts) is type-checked and overrun-capable (REVIEW-1 recheck N1)", () => {
    const nested = (media: unknown) => guard({ contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: { ok: true }, parts: [media] } }] }] });
    const image = nested({ inlineData: { mimeType: "image/png", data: "AAAA" } }); expect(image.ok && image.inputBounded).toBe(false);
    for (const bad of [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }, { fileData: { fileUri: "x" } }, { inlineData: { data: "AAAA" } }]) {
      const r = nested(bad); expect(!r.ok && r.message).toBe(PRODUCT_AUDIO_REFUSED);
    }
    const deep = guard({ systemInstruction: { parts: [{ functionResponse: { name: "f", response: { a: { b: [{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }] } } } }] }, contents: [{ parts: [{ text: "x" }] }] });
    expect(deep.ok && deep.inputBounded).toBe(false);
    // A tool's JSON schema that names a property "inlineData" is not content and stays bounded.
    const schema = guard({ ...text, tools: [{ functionDeclarations: [{ name: "f", parameters: { type: "object", properties: { inlineData: { type: "string" } } } }] }] });
    expect(schema.ok && schema.inputBounded).toBe(true);
  });
  it("snake_case media names are media too, nested or top level; extra fields on a top-level part are refused (REVIEW-1 recheck N2)", () => {
    const nested = (media: unknown) => guard({ contents: [{ parts: [{ functionResponse: { name: "f", response: {}, parts: [media] } }] }] });
    const image = nested({ inline_data: { mime_type: "image/png", data: "AAAA" } }); expect(image.ok && image.inputBounded).toBe(false);
    for (const bad of [{ inline_data: { mime_type: "audio/wav", data: "AAAA" } }, { file_data: { file_uri: "x" } }, { inline_data: { mimeType: "image/png", mime_type: "audio/wav", data: "AAAA" } }]) {
      const r = nested(bad); expect(!r.ok && r.message).toBe(PRODUCT_AUDIO_REFUSED);
    }
    for (const part of [{ thought: false, inline_data: { mime_type: "image/png", data: "AAAA" } }, { thoughtSignature: "x", inline_data: { mime_type: "audio/wav", data: "AAAA" } }, { text: "x", extra: 1 }]) {
      expect(guard({ contents: [{ parts: [part] }] }).ok).toBe(false);
    }
  });
  it("with no media prices, refuses audio, video and media with no declared type, inline or as a file (REVIEW-1 M1; DEC 228e file words)", () => {
    for (const part of [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }, { inlineData: { mimeType: "video/mp4", data: "AAAA" } }, { inlineData: { data: "AAAA" } },
      { fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/x" } }]) {
      const r = guard({ contents: [{ parts: [part] }] }); expect(r.ok).toBe(false); expect(!r.ok && r.message).toBe(PRODUCT_AUDIO_REFUSED);
    }
    for (const part of [{ fileData: { mimeType: "video/mp4", fileUri: "x" } }, { fileData: { mimeType: "AUDIO/mpeg", fileUri: "x" } }]) {
      const r = guard({ contents: [{ parts: [part] }] }); expect(r.ok).toBe(false); expect(!r.ok && r.message).toBe(PRODUCT_MEDIA_FILE_REFUSED);
    }
  });
  it("refuses server tools, audio input, non-text output and several candidates with fixed words", () => {
    for (const tool of [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: {} }, { functionDeclarations: [], googleSearch: {} }]) {
      const r = guard({ ...text, tools: [tool] }); expect(r.ok).toBe(false); expect(!r.ok && r.message).toBe(PRODUCT_TOOL_REFUSED);
    }
    const audio = guard({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }] }] }); expect(!audio.ok && audio.message).toBe(PRODUCT_AUDIO_REFUSED);
    expect(guard({ ...text, generationConfig: { responseModalities: ["IMAGE"] } }).ok).toBe(false);
    expect(guard({ ...text, generationConfig: { candidateCount: 2 } }).ok).toBe(false);
  });
  it("refuses unknown fields, a leftover Google credential, a wrong content type, empty or malformed contents, without echoing input", () => {
    for (const [body, h] of [
      [{ ...text, extra: 1 }, headers], [{ ...text, generationConfig: { speechConfig: {} } }, headers],
      [text, { ...headers, "x-goog-api-key": "dummy-value-1234" }], [text, { ...headers, "content-type": "text/plain" }],
      [{ contents: [] }, headers], [{ contents: [{ parts: [{ unknownKind: 1 }] }] }, headers], [{ contents: [{ parts: "x" }] }, headers],
      [{ contents: [{ role: "user", parts: [{ text: "x" }], secret: "planted-secret" }] }, headers],
    ] as const) {
      const r = guard(body, h); expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain("planted-secret"); expect(JSON.stringify(r)).not.toContain("dummy-value");
    }
  });
  it("one total item limit: a deeply nested body is refused in bounded time", () => {
    const started = performance.now();
    const r = guardGemini(Buffer.from(JSON.stringify({ contents: [{ parts: [{ functionResponse: { name: "f", response: { a: Array.from({ length: 1_100_000 }, () => 0) } } }] }] })), headers, path, limits);
    expect(r.ok).toBe(false); expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("Gemini usage", () => {
  it("maps cached prompt tokens to cache-read, tool prompt to input, answer plus thinking to output", () => {
    expect(geminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 40, toolUsePromptTokenCount: 5, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 115 })).toEqual({ input: 65, output: 10, cacheRead: 40, cacheWrite: 0 });
    for (const bad of [{}, { promptTokenCount: -1 }, { promptTokenCount: 1, cachedContentTokenCount: 2 }, { promptTokenCount: 1, candidatesTokenCount: 1.5 }, null]) expect(geminiUsage(bad)).toBeUndefined();
  });
  it("streams: last usage wins, a finish is required, split frames and CRLF are fine, errors and garbage fail the whole call", () => {
    const frame = (v: unknown) => `data: ${JSON.stringify(v)}\r\n\r\n`;
    const ok = new GeminiUsageCollector();
    const all = frame({ candidates: [{}], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }) + frame({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } });
    for (let i = 0; i < all.length; i += 7) ok.push(Buffer.from(all.slice(i, i + 7)));
    expect(ok.finish()).toEqual({ input: 5, output: 9, cacheRead: 0, cacheWrite: 0 });
    const noFinish = new GeminiUsageCollector(); noFinish.push(Buffer.from(frame({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }))); expect(noFinish.finish()).toBeUndefined();
    const error = new GeminiUsageCollector(); error.push(Buffer.from(frame({ error: { code: 500 } }))); expect(error.finish()).toBeUndefined();
    const garbage = new GeminiUsageCollector(); garbage.push(Buffer.from("hello\n\n")); expect(garbage.finish()).toBeUndefined();
    const backwards = new GeminiUsageCollector(); backwards.push(Buffer.from(frame({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } }) + frame({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }))); expect(backwards.finish()).toBeUndefined();
    const blocked = new GeminiUsageCollector(); blocked.push(Buffer.from(frame({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 4 } }))); expect(blocked.finish()).toEqual({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("Gemini transport", () => {
  function fakeRequest(onOptions: (o: Record<string, unknown>) => void, behaviour: "ok" | "error-before" | "error-after") {
    return ((options: Record<string, unknown>, callback: (r: unknown) => void) => {
      onOptions(options);
      const call = new EventEmitter() as EventEmitter & { end(b: unknown): void; destroy(): void };
      const socket = new EventEmitter();
      call.destroy = () => undefined;
      call.end = () => {
        call.emit("socket", socket);
        if (behaviour === "error-before") { call.emit("error", new Error("dns")); return; }
        socket.emit("secureConnect");
        if (behaviour === "error-after") { call.emit("error", new Error("reset")); return; }
        callback(Object.assign((async function* () { yield Buffer.from("x"); })(), { statusCode: 200, destroy: () => undefined }));
      };
      return call;
    }) as unknown as typeof https.request;
  }
  const input = (p = "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse") => ({ body: Buffer.from("{}"), headers: { "content-type": "application/json" }, key: "project-key-1234", signal: new AbortController().signal, path: p });
  it("fixed host, 443, TLS verified, no agent; the key only as x-goog-api-key", async () => {
    let seen: Record<string, unknown> = {};
    const r = await createGeminiTransport(fakeRequest((o) => { seen = o; }, "ok"))(input());
    expect(r.status).toBe(200);
    expect(seen).toMatchObject({ hostname: "generativelanguage.googleapis.com", port: 443, method: "POST", agent: false, rejectUnauthorized: true, path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse" });
    expect((seen.headers as Record<string, string>)["x-goog-api-key"]).toBe("project-key-1234");
  });
  it("a fault before the TLS handshake is not-sent; after it, possibly sent; an unchecked path never leaves", async () => {
    await expect(createGeminiTransport(fakeRequest(() => undefined, "error-before"))(input())).rejects.toBeInstanceOf(NotSentError);
    const after = await createGeminiTransport(fakeRequest(() => undefined, "error-after"))(input()).then(() => undefined, (e: unknown) => e);
    expect(after).toBeInstanceOf(Error); expect(after).not.toBeInstanceOf(NotSentError);
    let called = false;
    await expect(createGeminiTransport(fakeRequest(() => { called = true; }, "ok"))(input("/v1beta/models/x:generateContent?key=1"))).rejects.toBeInstanceOf(NotSentError);
    expect(called).toBe(false);
  });
});

describe("engine bridge contract", () => {
  it("the shared JSON equals the module and its SHA-256 is pinned (the same literal goes in Code's copy)", () => {
    const bytes = readFileSync("contracts/shared/model-gateway-product-ai.v1.json");
    expect(JSON.parse(bytes.toString())).toEqual(JSON.parse(JSON.stringify(PRODUCT_BRIDGE)));
    expect(bytes.toString().endsWith("}\n")).toBe(true); expect(bytes.toString()).not.toContain("\r");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("edf5eab5748e1e8f4ba204cbede6b0c2140424cd9fc5ef7ef2b487213bf871c8");
    expect(PRODUCT_BRIDGE.token.keyPurpose).toBe("task");
  });
});
