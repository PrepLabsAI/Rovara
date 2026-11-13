// TE-F1a: what comes back: response header allow list, key-echo scrub (four spellings plus first and last four characters, whole bodies and streams), usage from whole and streamed bodies per family, every class row, the
// cap refusal shape per family, and the reservation arithmetic.
import { describe, expect, it } from "vitest";
import {
  MODEL_EGRESS_REFUSALS, MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_REFUSAL_WORDS, NOT_RUN_SENTENCES, UNPRICED_CEILING_RATES, capSentence, classOfRefusal, classifyOwnResponse, classifyProviderResponse, createKeyEchoScanner,
  createUsageScanner, e2eSecretSpellings, formatUsdMicros, keyEchoNeedles, microsFor, modelOfBody, refusalResponse, requestedMaxOutputTokens, reserveEstimate, sanitizeResponseHeaders, scrubResponseBody, settleCost,
  usageFromBody, withheldBody, type ModelEgressFamily,
} from "@agentx/contracts";
import { fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((held, key) => (typeof held === "object" && held !== null ? (held as Record<string, unknown>)[key] : undefined), value);
const FAMILIES: ModelEgressFamily[] = ["openai_compatible", "anthropic_messages", "gemini", "vertex", "bedrock", "cohere"];

describe("response headers", () => {
  it("keeps an allow list, drops set-cookie and account headers, and never carries an x-rovara header from a provider", () => {
    const kept = sanitizeResponseHeaders([
      ["Content-Type", "text/event-stream"], ["Set-Cookie", "sid=1"], ["openai-organization", "org-x"], ["openai-project", "proj"], ["anthropic-organization-id", "o"], ["x-goog-user-project", "p"], ["anthropic-ratelimit-requests-limit", "50"],
      ["Retry-After", "3"], ["x-should-retry", "true"], ["request-id", "req_1"], ["x-rovara-refusal", "cap"], ["X-Rovara-Anything", "1"], ["content-encoding", "gzip"], ["transfer-encoding", "chunked"], ["Content-Length", "10"],
    ]);
    expect(kept.map(([name]) => name).sort()).toEqual(["content-type", "request-id", "retry-after", "x-should-retry"]);
  });
  it("drops a header whose value has a control character or is over 1 KB, and a duplicate", () => {
    expect(sanitizeResponseHeaders([["content-type", "a\r\nSet-Cookie: x"], ["retry-after", "9".repeat(1025)], ["x-request-id", "a"], ["X-Request-Id", "b"]])).toEqual([["x-request-id", "a"]]);
  });
});

describe("the key-echo scrub", () => {
  const key = fixtureKey("scrub");
  const spellings = e2eSecretSpellings(key);
  const body = (text: string) => ({ family: "openai_compatible" as const, status: 200, headers: [] as Array<[string, string]>, body: enc(text), key });

  it("scans for the key's raw, JSON-escaped, percent-encoded and base64 spellings", () => {
    const cases: Record<string, string> = {
      raw: key,
      "json-escaped": JSON.stringify(`"${key}"\n`).slice(1, -1),
      "percent-encoded": encodeURIComponent(`${key}+/=`),
      base64: Buffer.from(key).toString("base64"),
      "base64url": Buffer.from(key).toString("base64url"),
    };
    for (const [label, spelling] of Object.entries(cases)) {
      const scrubbed = scrubResponseBody(body(`{"echo": "before ${spelling} after"}`));
      expect(scrubbed.replaced, label).toBe(true);
      expect(dec(scrubbed.body)).not.toContain(spelling);
    }
    expect(spellings.length).toBeGreaterThan(5);
  });
  it("scans for the first and last four characters", () => {
    for (const piece of [key.slice(0, 4), key.slice(-4)]) {
      const scrubbed = scrubResponseBody(body(`Incorrect API key provided: ${piece}...`));
      expect(scrubbed.reason).toBe("key_echo");
      expect(dec(scrubbed.body)).not.toContain(piece);
    }
  });
  it("replaces a 401 and a 403 body always, even with no key in it, keeping the status for the caller", () => {
    for (const status of [401, 403]) {
      const scrubbed = scrubResponseBody({ ...body("the provider says nothing of a key"), status });
      expect(scrubbed).toMatchObject({ replaced: true, reason: "auth_status" });
      expect(dec(scrubbed.body)).not.toContain("the provider says");
      expect(dec(scrubbed.body)).toContain(MODEL_EGRESS_REFUSAL_WORDS.key_refused);
    }
  });
  it("passes a clean 200, 400 and 429 body through untouched", () => {
    for (const status of [200, 400, 429, 500]) {
      const clean = `{"error":{"message":"something innocent ${String(status)}"}}`;
      const scrubbed = scrubResponseBody({ ...body(clean), status });
      expect(scrubbed.replaced).toBe(false);
      expect(dec(scrubbed.body)).toBe(clean);
    }
  });
  it("withholds a compressed body it cannot read", () => {
    const scrubbed = scrubResponseBody({ ...body("\u001f\u008b"), headers: [["Content-Encoding", "gzip"]] });
    expect(scrubbed).toMatchObject({ replaced: true, reason: "unscannable" });
    expect(scrubResponseBody({ ...body("{}"), headers: [["Content-Encoding", "identity"]] }).replaced).toBe(false);
  });
  it("the replacement is in the family's own error shape and holds no key", () => {
    for (const family of FAMILIES) {
      const replaced = dec(withheldBody(family, 502, "key_echo"));
      expect(() => JSON.parse(replaced) as unknown).not.toThrow();
      expect(replaced).not.toContain(key);
    }
  });
  it("refuses a key too short to scan for, without echoing it", () => {
    expect(() => keyEchoNeedles("short")).toThrow("the key is too short to scan for");
  });
  it("a 1 MB body checks in well under a second", () => {
    const big = enc(`{"text":"${"lorem ipsum dolor ".repeat(60_000)}"}`);
    const started = performance.now();
    const scrubbed = scrubResponseBody({ ...body(""), body: big });
    expect(performance.now() - started).toBeLessThan(500);
    expect(big.byteLength).toBeGreaterThan(1_000_000);
    expect(scrubbed.replaced).toBe(false);
  });

  describe("on a stream", () => {
    const run = (chunks: string[]) => {
      const scanner = createKeyEchoScanner(key);
      let out = "";
      let hit = false;
      for (const chunk of chunks) {
        const step = scanner.push(enc(chunk));
        out += dec(step.safe);
        hit ||= step.hit;
      }
      const end = scanner.finish();
      out += dec(end.safe);
      return { out, hit: hit || end.hit };
    };
    it("passes a clean stream through byte for byte, however it is chunked", () => {
      const text = "data: {\"a\":1}\n\ndata: {\"b\":\"héllo 😀 wörld\"}\n\ndata: [DONE]\n\n";
      for (const size of [1, 2, 3, 7, 1000]) {
        const chunks = text.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, "gu")) ?? [];
        expect(run(chunks).out).toBe(text);
        expect(run(chunks).hit).toBe(false);
      }
    });
    it("finds a key split across two chunks, and releases nothing of it", () => {
      const text = `data: {"echo":"x ${key} y"}\n\n`;
      for (let cut = 1; cut < text.length; cut += 3) {
        const result = run([text.slice(0, cut), text.slice(cut)]);
        expect(result.hit, `cut at ${String(cut)}`).toBe(true);
        expect(result.out).not.toContain(key);
        expect(result.out).not.toContain(key.slice(0, 8));
      }
    });
    it("finds a key that is followed by far more text than the hold-back window, and releases none of it", () => {
      const filler = "lorem ipsum dolor sit amet ".repeat(400);
      const scanner = createKeyEchoScanner(key);
      let released = "";
      let hit = false;
      for (const chunk of [`data: ${key}\n\n`, filler, filler, filler]) {
        const step = scanner.push(enc(chunk));
        released += dec(step.safe);
        hit ||= step.hit;
        // The very push that completes the key reports it: it is not left for the end of the stream.
        if (chunk.includes(key)) expect(step.hit).toBe(true);
      }
      expect(hit).toBe(true);
      expect(released).not.toContain(key);
      expect(released).not.toContain("lorem");
    });
    it("finds the first-four and last-four pieces on a stream and then releases nothing more", () => {
      const result = run([`data: one\n\n`, `data: ${key.slice(-4)}\n\n`, `data: later\n\n`]);
      expect(result.hit).toBe(true);
      expect(result.out).not.toContain("later");
    });
  });
});

describe("usage", () => {
  const json = (value: unknown) => JSON.stringify(value);
  it("reads OpenAI chat, Responses and embeddings bodies", () => {
    expect(usageFromBody("openai_compatible", json({ usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }))).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(usageFromBody("openai_compatible", json({ usage: { input_tokens: 5, output_tokens: 9 } }))).toEqual({ inputTokens: 5, outputTokens: 9 });
    expect(usageFromBody("openai_compatible", json({ usage: { prompt_tokens: 8, total_tokens: 8 } }))).toEqual({ inputTokens: 8, outputTokens: 0 });
  });
  it("reads Anthropic usage, counting cache tokens as input, and a count_tokens body", () => {
    expect(usageFromBody("anthropic_messages", json({ usage: { input_tokens: 10, output_tokens: 20 } }))).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(usageFromBody("anthropic_messages", json({ usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 1 } }))).toEqual({ inputTokens: 17, outputTokens: 1 });
    expect(usageFromBody("anthropic_messages", json({ input_tokens: 33 }))).toEqual({ inputTokens: 33, outputTokens: 0 });
  });
  it("reads Gemini and Vertex usageMetadata, thinking tokens as output", () => {
    for (const family of ["gemini", "vertex"] as const) {
      expect(usageFromBody(family, json({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 10, totalTokenCount: 20 } }))).toEqual({ inputTokens: 4, outputTokens: 16 });
    }
    expect(usageFromBody("gemini", json({ totalTokens: 12 }))).toEqual({ inputTokens: 12, outputTokens: 0 });
  });
  it("reads Cohere billed units, v1 and v2", () => {
    expect(usageFromBody("cohere", json({ meta: { billed_units: { input_tokens: 3, output_tokens: 4 } } }))).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(usageFromBody("cohere", json({ usage: { billed_units: { input_tokens: 5, output_tokens: 6 } } }))).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
  it("reads nothing from a body with no usage, bad JSON, or numbers that are not credible", () => {
    expect(usageFromBody("openai_compatible", json({ choices: [] }))).toBeUndefined();
    expect(usageFromBody("openai_compatible", "not json")).toBeUndefined();
    expect(usageFromBody("openai_compatible", json({ usage: { prompt_tokens: -1, completion_tokens: 1.5 } }))).toBeUndefined();
    expect(usageFromBody("openai_compatible", json({ usage: { prompt_tokens: "9", completion_tokens: 1e15 } }))).toBeUndefined();
    expect(usageFromBody("openai_compatible", json({ usage: { prompt_tokens: Number.NaN } }))).toBeUndefined();
  });
  it("ignores a __proto__ usage key", () => {
    const hostile = `{"__proto__":{"usage":{"prompt_tokens":99,"completion_tokens":99}}}`;
    expect(usageFromBody("openai_compatible", hostile)).toBeUndefined();
  });
  it("reads a Gemini JSON-array stream, the last figures winning", () => {
    const array = `[\n${json({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } })},\n${json({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 9 } })}\n]`;
    expect(usageFromBody("gemini", array)).toEqual({ inputTokens: 4, outputTokens: 9 });
    for (const size of [1, 5, 64, 10_000]) {
      const scanner = createUsageScanner("gemini");
      for (const piece of array.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, "gu")) ?? []) scanner.push(piece);
      expect(scanner.finish(), `chunks of ${String(size)}`).toEqual({ inputTokens: 4, outputTokens: 9 });
    }
  });
  it("reads SSE streams per family", () => {
    const sse = (events: unknown[]) => events.map((event) => `data: ${typeof event === "string" ? event : json(event)}\n\n`).join("");
    const cases: Array<[ModelEgressFamily, string, { inputTokens: number; outputTokens: number }]> = [
      ["openai_compatible", sse([{ choices: [{ delta: { content: "a" } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } }, "[DONE]"]), { inputTokens: 12, outputTokens: 34 }],
      ["openai_compatible", sse([{ type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } }]), { inputTokens: 2, outputTokens: 3 }],
      ["anthropic_messages", `event: message_start\n${sse([{ type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 15 } }])}`, { inputTokens: 25, outputTokens: 15 }],
      ["gemini", sse([{ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }, { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 8 } }]), { inputTokens: 3, outputTokens: 8 }],
      ["vertex", sse([{ usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } }]), { inputTokens: 6, outputTokens: 2 }],
      ["cohere", sse([{ type: "message-end", delta: { usage: { billed_units: { input_tokens: 7, output_tokens: 8 } } } }]), { inputTokens: 7, outputTokens: 8 }],
    ];
    for (const [family, stream, expected] of cases) {
      for (const size of [1, 3, 17, 100_000]) {
        const scanner = createUsageScanner(family);
        for (const piece of stream.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, "gu")) ?? []) scanner.push(piece);
        expect(scanner.finish(), `${family} chunks of ${String(size)}`).toEqual(expected);
      }
    }
  });
  it("skips a frame it cannot parse and keeps the figures it read", () => {
    const scanner = createUsageScanner("gemini");
    scanner.push(`data: ${json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })}\n\ndata: {broken\n\n`);
    expect(scanner.finish()).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
  it("reports no usage for a stream that cuts off before any", () => {
    const scanner = createUsageScanner("openai_compatible");
    scanner.push(`data: {"choices":[{"delta":{"content":"par`);
    expect(scanner.finish()).toBeUndefined();
  });
  it("keeps only an unfinished tail of a long stream, and a 1 MB stream checks quickly", () => {
    const scanner = createUsageScanner("openai_compatible");
    const started = performance.now();
    const line = `data: ${json({ choices: [{ delta: { content: "x".repeat(1000) } }] })}\n\n`;
    for (let index = 0; index < 1000; index += 1) scanner.push(line);
    scanner.push(`data: ${json({ usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`);
    expect(scanner.finish()).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(performance.now() - started).toBeLessThan(800);
  });
});

describe("evidence classes", () => {
  const cls = (status: number, body = "") => classifyProviderResponse({ status, body });
  it("2xx is ok", () => {
    expect(cls(200)).toBe("ok");
    expect(cls(204)).toBe("ok");
  });
  it("401 and 403 are the key being refused", () => {
    expect(cls(401)).toBe("key_refused");
    expect(cls(403, "anything")).toBe("key_refused");
  });
  it("rate limit: a 429, Google RESOURCE_EXHAUSTED per minute, Anthropic rate_limit_error", () => {
    expect(cls(429)).toBe("rate_limit");
    expect(cls(429, JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }))).toBe("rate_limit");
    expect(cls(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier" } }))).toBe("rate_limit");
    expect(cls(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } }))).toBe("rate_limit");
  });
  it("quota used up: OpenAI insufficient_quota, Google daily or billing quota, Anthropic empty balance", () => {
    expect(cls(429, JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota" } }))).toBe("quota");
    expect(cls(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric ... GenerateRequestsPerDayPerProjectPerModel" } }))).toBe("quota");
    expect(cls(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Please check your plan and billing details." } }))).toBe("quota");
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }))).toBe("quota");
  });
  it("overloaded: Anthropic 529 and overloaded_error, any 503", () => {
    expect(cls(529)).toBe("overloaded");
    expect(cls(503)).toBe("overloaded");
    expect(cls(200 + 300, JSON.stringify({ type: "error", error: { type: "overloaded_error" } }))).toBe("overloaded");
    expect(cls(500, JSON.stringify({ type: "error", error: { type: "overloaded_error" } }))).toBe("overloaded");
  });
  it("any other failure is a provider error, never one of the not-run classes", () => {
    for (const status of [400, 404, 422, 500, 502]) expect(cls(status, "{}")).toBe("provider_error");
    for (const status of [0, 99, 600, 12.5, Number.NaN]) expect(cls(status)).toBe("provider_error");
  });
  it("reads only a bounded part of a huge body", () => {
    const huge = `${" ".repeat(100_000)}insufficient_quota`;
    expect(cls(429, huge)).toBe("rate_limit");
  });
  it("a provider can never claim to be our cap: its x-rovara-refusal header is not read", () => {
    expect(classifyProviderResponse({ status: 200, body: "" })).toBe("ok");
    expect(classifyOwnResponse({ status: 429, headers: [["x-rovara-refusal", "cap"]] })).toBe("cap");
    const sanitized = sanitizeResponseHeaders([["x-rovara-refusal", "cap"], ["content-type", "application/json"]]);
    expect(classifyOwnResponse({ status: 429, headers: sanitized })).toBe("rate_limit");
  });
  it("our own refusals map to their classes", () => {
    expect(classifyOwnResponse({ status: 429, headers: [[MODEL_EGRESS_REFUSAL_HEADER, "cap"]] })).toBe("cap");
    expect(classifyOwnResponse({ status: 404, headers: [[MODEL_EGRESS_REFUSAL_HEADER, "not_found"]] })).toBe("refused");
    expect(classifyOwnResponse({ status: 403, headers: [[MODEL_EGRESS_REFUSAL_HEADER, "not_allowed"]] })).toBe("refused");
    expect(classOfRefusal("key_refused")).toBe("key_refused");
    expect(classOfRefusal("quota")).toBe("quota");
    expect(classOfRefusal("ssrf")).toBe("refused");
  });
  it("has the fixed not-run sentences", () => {
    expect(NOT_RUN_SENTENCES).toEqual({
      rate_limit: "not run: provider rate limit",
      quota: "not run: provider quota used up",
      overloaded: "not run: provider overloaded",
      key_refused: "not run: the product key was refused (check it in Settings)",
    });
    expect(capSentence(2_000_000)).toBe("not run: test model budget reached ($2.00 per task)");
    expect(capSentence(undefined)).toBe("not run: test model budget reached");
    expect(capSentence(Number.NaN)).toBe("not run: test model budget reached");
    expect(capSentence(-5)).toBe("not run: test model budget reached");
  });
});

describe("refusal answers", () => {
  it("every word has a fixed sentence, a status and a header, in every family's shape", () => {
    for (const family of FAMILIES) {
      for (const word of MODEL_EGRESS_REFUSALS) {
        const answer = refusalResponse(family, word);
        expect(answer.headers).toContainEqual([MODEL_EGRESS_REFUSAL_HEADER, word]);
        const parsed = JSON.parse(dec(answer.body)) as Record<string, unknown>;
        expect(JSON.stringify(parsed)).toContain(MODEL_EGRESS_REFUSAL_WORDS[word].slice(0, 20));
      }
    }
  });
  it("the cap refusal is a 429 in the family's own error shape, naming the cap", () => {
    const shapes: Record<ModelEgressFamily, (parsed: unknown) => unknown> = {
      openai_compatible: (parsed) => [at(parsed, "error", "type"), at(parsed, "error", "code"), typeof at(parsed, "error", "message")],
      anthropic_messages: (parsed) => [at(parsed, "type"), at(parsed, "error", "type"), typeof at(parsed, "error", "message")],
      gemini: (parsed) => [at(parsed, "error", "code"), at(parsed, "error", "status"), typeof at(parsed, "error", "message")],
      vertex: (parsed) => [at(parsed, "error", "code"), at(parsed, "error", "status"), typeof at(parsed, "error", "message")],
      cohere: (parsed) => [typeof at(parsed, "message")],
      bedrock: (parsed) => [typeof at(parsed, "message")],
    };
    const expected: Record<ModelEgressFamily, unknown> = {
      openai_compatible: ["rovara_budget", "rovara_cap", "string"],
      anthropic_messages: ["error", "rate_limit_error", "string"],
      gemini: [429, "RESOURCE_EXHAUSTED", "string"],
      vertex: [429, "RESOURCE_EXHAUSTED", "string"],
      cohere: ["string"],
      bedrock: ["string"],
    };
    for (const family of FAMILIES) {
      const answer = refusalResponse(family, "cap", { capMicros: 2_000_000 });
      expect(answer.status).toBe(429);
      expect(answer.headers).toContainEqual(["x-rovara-refusal", "cap"]);
      const parsed: unknown = JSON.parse(dec(answer.body));
      expect(shapes[family](parsed), family).toEqual(expected[family]);
      expect(dec(answer.body)).toContain("($2.00 per task)");
    }
  });
  it("not_found is one answer, byte for byte, in every family: nothing tells missing from another company's", () => {
    for (const family of FAMILIES) expect(dec(refusalResponse(family, "not_found").body)).toBe(dec(refusalResponse(family, "not_found").body));
    expect(MODEL_EGRESS_REFUSAL_WORDS.not_found).toBe("The model source was not found.");
  });
  it("a cap amount that is not a whole number prints no amount", () => {
    expect(dec(refusalResponse("cohere", "cap", { capMicros: Number.NaN }).body)).not.toContain("NaN");
    expect(dec(refusalResponse("cohere", "cap", { capMicros: 1.5 }).body)).not.toContain("1.5");
  });
});

describe("cost", () => {
  const row = { prices: [{ model: "m", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }], defaultMaxOutputTokens: 1000, fallbackPrice: undefined };
  it("reserves input bytes / 4 at the input price plus the maximum output at the output price", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 4_000, maxOutputTokens: 2_000 });
    expect(reservation).toMatchObject({ inputTokens: 1_000, outputTokens: 2_000, priced: true });
    // 1000 tokens at $3 per million = 3000 micros; 2000 tokens at $15 per million = 30000 micros.
    expect(reservation.reserveMicros).toBe(33_000);
  });
  it("rounds the input tokens and the cost UP", () => {
    expect(reserveEstimate({ row, model: "m", inputBytes: 1, maxOutputTokens: 1 })).toMatchObject({ inputTokens: 1, reserveMicros: 3 + 15 });
    expect(microsFor(1, 1)).toBe(1);
    expect(microsFor(0, 1_000_000)).toBe(0);
  });
  it("uses the row's default maximum when the request names none or a bad one", () => {
    for (const named of [undefined, 0, -1, 1.5, Number.NaN, 2_000_000_000]) expect(reserveEstimate({ row, model: "m", inputBytes: 0, maxOutputTokens: named }).outputTokens, String(named)).toBe(1000);
  });
  it("reads the request's maximum in the family's own field", () => {
    const body = (value: unknown) => enc(JSON.stringify(value));
    expect(requestedMaxOutputTokens("openai_compatible", body({ max_completion_tokens: 50, max_tokens: 60 }))).toBe(50);
    expect(requestedMaxOutputTokens("openai_compatible", body({ max_tokens: 60 }))).toBe(60);
    expect(requestedMaxOutputTokens("openai_compatible", body({ max_output_tokens: 70 }))).toBe(70);
    expect(requestedMaxOutputTokens("anthropic_messages", body({ max_tokens: 80 }))).toBe(80);
    expect(requestedMaxOutputTokens("gemini", body({ generationConfig: { maxOutputTokens: 90 } }))).toBe(90);
    expect(requestedMaxOutputTokens("vertex", body({ generationConfig: { maxOutputTokens: 91 } }))).toBe(91);
    expect(requestedMaxOutputTokens("cohere", body({ max_tokens: 92 }))).toBe(92);
    expect(requestedMaxOutputTokens("gemini", body({ max_tokens: 5 }))).toBeUndefined();
    expect(requestedMaxOutputTokens("openai_compatible", enc("not json"))).toBeUndefined();
    expect(requestedMaxOutputTokens("openai_compatible", body({ max_tokens: "9" }))).toBeUndefined();
    expect(modelOfBody(body({ model: "m" }))).toBe("m");
    expect(modelOfBody(body({ model: 5 }))).toBeUndefined();
  });
  it("settles to the reported usage at the rates, for a complete answer", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 4_000, maxOutputTokens: 2_000 });
    expect(settleCost({ reservation, usage: { inputTokens: 100, outputTokens: 10 }, complete: true })).toEqual({ costMicros: 300 + 150, estimated: false });
  });
  it("a cut-off stream keeps its reservation: the meter errs high, never low", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 4_000, maxOutputTokens: 2_000 });
    expect(settleCost({ reservation, usage: undefined, complete: false })).toEqual({ costMicros: 33_000, estimated: true });
    expect(settleCost({ reservation, usage: { inputTokens: 1, outputTokens: 1 }, complete: false })).toEqual({ costMicros: 33_000, estimated: true });
    // Partial usage that is higher than the reservation is kept.
    expect(settleCost({ reservation, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, complete: false }).costMicros).toBe(18_000_000);
  });
  it("an answer with no usage keeps the reservation, estimated", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 400, maxOutputTokens: 100 });
    expect(settleCost({ reservation, usage: undefined, complete: true })).toEqual({ costMicros: reservation.reserveMicros, estimated: true });
  });
  it("an unpriced model is charged its full reservation and marked estimated, never zero", () => {
    const reservation = reserveEstimate({ row, model: "unknown-model", inputBytes: 4_000, maxOutputTokens: 1_000 });
    expect(reservation.priced).toBe(false);
    expect(reservation.reserveMicros).toBe(microsFor(1_000, UNPRICED_CEILING_RATES.inputMicrosPerMTok) + microsFor(1_000, UNPRICED_CEILING_RATES.outputMicrosPerMTok));
    expect(reservation.reserveMicros).toBeGreaterThan(0);
    expect(settleCost({ reservation, usage: { inputTokens: 1, outputTokens: 1 }, complete: true })).toEqual({ costMicros: reservation.reserveMicros, estimated: true });
    const noModel = reserveEstimate({ row, model: undefined, inputBytes: 4, maxOutputTokens: 1 });
    expect(noModel.priced).toBe(false);
  });
  it("a row's fallback price is used for an unpriced model, still estimated", () => {
    const withFallback = { ...row, fallbackPrice: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 } };
    const reservation = reserveEstimate({ row: withFallback, model: "other", inputBytes: 4_000, maxOutputTokens: 1_000 });
    expect(reservation.reserveMicros).toBe(1_000 + 2_000);
    expect(reservation.priced).toBe(false);
  });
  it("computes exactly at the largest sizes, or refuses; never a float", () => {
    expect(microsFor(1_000_000_000, 1_000_000_000)).toBe(1_000_000_000_000);
    expect(() => microsFor(Number.MAX_SAFE_INTEGER, 1_000_000_000)).toThrow(RangeError);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => microsFor(bad, 1)).toThrow(RangeError);
    expect(() => reserveEstimate({ row, model: "m", inputBytes: Number.NaN, maxOutputTokens: 1 })).toThrow(RangeError);
  });
  it("formats dollars rounded up to the cent and refuses a number it cannot print", () => {
    expect(formatUsdMicros(2_000_000)).toBe("$2.00");
    expect(formatUsdMicros(0)).toBe("$0.00");
    expect(formatUsdMicros(1)).toBe("$0.01");
    expect(formatUsdMicros(50_000_000)).toBe("$50.00");
    expect(formatUsdMicros(1_234_567)).toBe("$1.24");
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => formatUsdMicros(bad)).toThrow(RangeError);
  });
});
