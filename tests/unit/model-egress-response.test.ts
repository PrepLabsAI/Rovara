// TE-F1a: what comes back: response header allow list, key-echo scrub (four spellings plus first and last four characters, whole bodies and streams), usage from whole and streamed bodies per family, every class row, the
// cap refusal shape per family, and the reservation arithmetic.
import { describe, expect, it } from "vitest";
import {
  MODEL_EGRESS_REFUSALS, MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_REFUSAL_WORDS, NOT_RUN_SENTENCES, UNPRICED_CEILING_RATES, capSentence, classOfRefusal, classifyOwnResponse, classifyProviderResponse, createKeyEchoScanner,
  createUsageScanner, e2eSecretSpellings, formatUsdMicros, keyEchoNeedles, microsFor, modelOfBody, refusalResponse, requestedMaxOutputTokens, reserveEstimate, sanitizeResponseHeaders, scrubResponseBody, settleCost,
  usageFromBody, withheldBody, withDefaultMaxOutput, hasExternalInput, MODEL_EGRESS_OVERRUN_SENTENCE, isOverCap, maxOutputFieldOf, type ModelEgressFamily,
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

describe("response header values are scanned for the key", () => {
  const key = fixtureKey("header-scan");
  it("drops an allow-listed header whose value holds any spelling of the key, and keeps the others", () => {
    const spellings = e2eSecretSpellings(key);
    for (const spelling of spellings.slice(0, 8)) {
      const kept = sanitizeResponseHeaders([["content-type", "application/json"], ["x-request-id", `echo-${spelling}`], ["request-id", spelling.toUpperCase()], ["retry-after", "3"]], { key });
      expect(kept, spelling).toEqual([["content-type", "application/json"], ["retry-after", "3"]]);
    }
    expect(sanitizeResponseHeaders([["x-request-id", "req_123"], ["content-type", "text/event-stream"]], { key })).toEqual([["x-request-id", "req_123"], ["content-type", "text/event-stream"]]);
    expect(sanitizeResponseHeaders([["x-request-id", `echo-${key}`]])).toEqual([["x-request-id", `echo-${key}`]]);
  });
  it("a key too short to scan for is refused, never skipped", () => {
    expect(() => sanitizeResponseHeaders([["x-request-id", "a"]], { key: "short" })).toThrow(/too short/u);
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
    it("finds EVERY spelling of the key (base64, base64url, hex, percent-encoded, JSON-escaped, and the alignment-independent base64 fragments) split across two chunks at every position, and releases none of it", () => {
      const spellings = e2eSecretSpellings(key).filter((spelling) => spelling.length >= 12);
      expect(spellings.length).toBeGreaterThanOrEqual(6);
      for (const spelling of spellings) {
        const text = `data: {"echo":"${spelling}"}\n\n`;
        // A fragment of the middle of the spelling: if any of it is released, the key left the proxy.
        const middle = spelling.slice(Math.floor(spelling.length / 2) - 5, Math.floor(spelling.length / 2) + 5);
        for (let cut = 1; cut < text.length; cut += 1) {
          const result = run([text.slice(0, cut), text.slice(cut)]);
          expect(result.hit, `${spelling}, cut at ${String(cut)}`).toBe(true);
          expect(result.out, `${spelling}, cut at ${String(cut)}`).not.toContain(middle);
        }
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
  it("free text in a 400, 402, 404, 413 or 500 never reclassifies a failure (the word rules are for 429, 503 and 529 only)", () => {
    const text = (message: string) => JSON.stringify({ error: { message } });
    expect(cls(400, text("invalid value for 'daily' in prompt"))).toBe("provider_error");
    expect(cls(400, text("Your prompt 'my server is overloaded' is invalid"))).toBe("provider_error");
    expect(cls(500, JSON.stringify({ error: "internal; please retry" }))).toBe("provider_error");
    expect(cls(404, text("model not found; check billing details"))).toBe("provider_error");
    expect(cls(402, JSON.stringify({ error: "payment required" }))).toBe("provider_error");
    expect(cls(413, "too large; retry")).toBe("provider_error");
    expect(cls(400, text("quota exceeded, insufficient_quota, rate limit"))).toBe("provider_error");
    expect(cls(404, text("RESOURCE_EXHAUSTED"))).toBe("provider_error");
    expect(cls(400, JSON.stringify({ error: { code: 400, message: "User location is not supported" } }))).toBe("provider_error");
  });
  it("uses structured fields on other statuses: error.type, error.code, status, and Google's API_KEY_INVALID reason", () => {
    const keyInvalid = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } });
    expect(cls(400, keyInvalid)).toBe("key_refused");
    expect(cls(200 + 300, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }))).toBe("overloaded");
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }))).toBe("rate_limit");
    expect(cls(400, JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "x" } }))).toBe("quota");
    expect(cls(400, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "x" } }))).toBe("rate_limit");
    expect(cls(400, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel" } }))).toBe("quota");
    expect(cls(400, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quotaId: GenerateRequestsPerMinutePerProjectPerModel" } }))).toBe("rate_limit");
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }))).toBe("quota");
    // Only Anthropic's own envelope counts, and only its fixed sentence at the START of the message (a prompt can be echoed anywhere else in it).
    const credit = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: credit }, request_id: "req_1" }))).toBe("quota");
    expect(cls(402, JSON.stringify({ type: "error", error: { type: "billing_error", message: "x" } }))).toBe("quota");
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `messages.0: you said "${credit}"` } }))).toBe("provider_error");
    expect(cls(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: credit, extra: 1 } }))).toBe("provider_error");
    expect(cls(400, JSON.stringify({ type: "error", surprise: 1, error: { type: "invalid_request_error", message: credit } }))).toBe("provider_error");
    expect(cls(400, JSON.stringify({ error: { type: "invalid_request_error", message: credit } }))).toBe("provider_error");
    expect(cls(404, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: credit } }))).toBe("provider_error");
    // The credit-balance sentence outside Anthropic's structured error is only free text.
    expect(cls(400, JSON.stringify({ error: { message: "Your credit balance is too low" } }))).toBe("provider_error");
    expect(cls(400, "Your credit balance is too low")).toBe("provider_error");
    expect(cls(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Quota exceeded" } }))).toBe("key_refused");
  });
  it("a hostile __proto__ in an error body reclassifies nothing", () => {
    expect(cls(400, `{"error":{"__proto__":{"type":"overloaded_error"}}}`)).toBe("provider_error");
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
    expect(requestedMaxOutputTokens("openai_compatible", body({ max_completion_tokens: 50, max_tokens: 60 }))).toBe(60);
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
    expect(settleCost({ reservation, usage: { inputTokens: 100, outputTokens: 10 }, complete: true })).toMatchObject({ costMicros: 300 + 150, estimated: false });
  });
  it("a cut-off stream keeps its reservation: the meter errs high, never low", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 4_000, maxOutputTokens: 2_000 });
    expect(settleCost({ reservation, usage: undefined, complete: false })).toMatchObject({ costMicros: 33_000, estimated: true });
    expect(settleCost({ reservation, usage: { inputTokens: 1, outputTokens: 1 }, complete: false })).toMatchObject({ costMicros: 33_000, estimated: true });
    // Partial usage that is higher than the reservation is kept.
    expect(settleCost({ reservation, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, complete: false }).costMicros).toBe(18_000_000);
  });
  it("an answer with no usage keeps the reservation, estimated", () => {
    const reservation = reserveEstimate({ row, model: "m", inputBytes: 400, maxOutputTokens: 100 });
    expect(settleCost({ reservation, usage: undefined, complete: true })).toMatchObject({ costMicros: reservation.reserveMicros, estimated: true });
  });
  it("an unpriced model is charged its full reservation and marked estimated, never zero", () => {
    const reservation = reserveEstimate({ row, model: "unknown-model", inputBytes: 4_000, maxOutputTokens: 1_000 });
    expect(reservation.priced).toBe(false);
    expect(reservation.reserveMicros).toBe(microsFor(1_000, UNPRICED_CEILING_RATES.inputMicrosPerMTok) + microsFor(1_000, UNPRICED_CEILING_RATES.outputMicrosPerMTok));
    expect(reservation.reserveMicros).toBeGreaterThan(0);
    expect(settleCost({ reservation, usage: { inputTokens: 1, outputTokens: 1 }, complete: true })).toMatchObject({ costMicros: reservation.reserveMicros, estimated: true });
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
  describe("the cap cannot be overrun by one call (review M1)", () => {
    const fileBody = enc(JSON.stringify({ contents: [{ parts: [{ fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mimeType: "video/mp4" } }] }] }));
    const probeUsage = usageFromBody("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 900_000, candidatesTokenCount: 60_000, thoughtsTokenCount: 20_000 } }));
    const large = { prices: [{ model: "fixture-large", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }], defaultMaxOutputTokens: 1024, fallbackPrice: undefined };

    it("the reviewer's probe: a file request used to reserve 15,462 micro-dollars and settle at 3,900,000; now the reservation holds it", () => {
      const before = reserveEstimate({ row: large, model: "fixture-large", inputBytes: fileBody.byteLength, maxOutputTokens: undefined });
      expect(before.reserveMicros).toBeLessThan(20_000); // what a body-size estimate alone gives: far below the real cost
      const reservation = reserveEstimate({ row: large, model: "fixture-large", inputBytes: fileBody.byteLength, maxOutputTokens: undefined, externalInput: true });
      expect(reservation.reserveMicros).toBeGreaterThanOrEqual(3_900_000);
      const settled = settleCost({ reservation, usage: probeUsage, complete: true });
      expect(settled.costMicros).toBe(3_900_000);
      expect(settled.aboveReservation).toBe(false);
    });
    it("a row setting names the reservation for external input; the default is two million tokens", () => {
      const own = reserveEstimate({ row: { ...large, externalInputReserveTokens: 500_000 }, model: "fixture-large", inputBytes: 10, maxOutputTokens: 100, externalInput: true });
      expect(own.inputTokens).toBe(500_000);
      expect(reserveEstimate({ row: large, model: "fixture-large", inputBytes: 10, maxOutputTokens: 100, externalInput: true }).inputTokens).toBe(2_000_000);
      // A body bigger than the setting keeps its own size.
      expect(reserveEstimate({ row: { ...large, externalInputReserveTokens: 10 }, model: "fixture-large", inputBytes: 4_000, maxOutputTokens: 100, externalInput: true }).inputTokens).toBe(1_000);
    });
    it("sees file and cached-content references anywhere in a request, in every spelling", () => {
      const has = (value: unknown) => hasExternalInput(enc(JSON.stringify(value)));
      expect(has({ contents: [{ parts: [{ text: "a" }, { fileData: { fileUri: "x" } }] }] })).toBe(true);
      expect(has({ contents: [{ parts: [{ file_data: { file_uri: "x" } }] }] })).toBe(true);
      expect(has({ cachedContent: "cachedContents/abc", contents: [] })).toBe(true);
      expect(has({ cached_content: "cachedContents/abc" })).toBe(true);
      expect(has({ messages: [{ content: [{ type: "input_file", file_id: "file-1" }] }] })).toBe(true);
      expect(has({ a: { b: { c: { d: [{ fileUri: "x" }] } } } })).toBe(true);
      // Input of unknown size by another road (review L5): a fetched image, a URL source, a stored conversation, the URL-context tool.
      expect(has({ messages: [{ content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }] })).toBe(true);
      expect(has({ messages: [{ content: [{ type: "image_url", image_url: "https://example.test/a.png" }] }] })).toBe(true);
      expect(has({ messages: [{ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] })).toBe(false);
      expect(has({ messages: [{ content: [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }] }] })).toBe(true);
      expect(has({ messages: [{ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] })).toBe(false);
      expect(has({ previous_response_id: "resp_1", input: "x" })).toBe(true);
      expect(has({ contents: [], tools: [{ urlContext: {} }] })).toBe(true);
      expect(has({ contents: [], tools: [{ url_context: {} }] })).toBe(true);
      // Too deep, or too many nodes to scan, counts as holding one: the answer fails HIGH (review L6).
      expect(hasExternalInput(`${'{"a":'.repeat(70)}1${"}".repeat(70)}`)).toBe(true);
      expect(hasExternalInput(`${'{"a":'.repeat(64)}1${"}".repeat(64)}`)).toBe(false);
      expect(hasExternalInput(JSON.stringify({ list: Array.from({ length: 200_001 }, () => 1) }))).toBe(true);
      expect(has({ contents: [{ parts: [{ text: "mentions fileData and cachedContent only as text" }] }] })).toBe(false);
      expect(hasExternalInput(enc("not json"))).toBe(false);
      expect(hasExternalInput(enc(JSON.stringify({ a: 1 })))).toBe(false);
    });
    it("a call above its ESTIMATE is not an overrun; the cap is overrun only when the SPEND passes the cap (DECISIONS 165)", () => {
      const reservation = reserveEstimate({ row: large, model: "fixture-large", inputBytes: 400, maxOutputTokens: 100 });
      expect(settleCost({ reservation, usage: { inputTokens: 5_000_000, outputTokens: 1 }, complete: true })).toMatchObject({ aboveReservation: true });
      expect(settleCost({ reservation, usage: { inputTokens: 1, outputTokens: 1 }, complete: true }).aboveReservation).toBe(false);
      expect(settleCost({ reservation, usage: undefined, complete: false }).aboveReservation).toBe(false);
      // $50 cap, a call that settled at 3,006 micro-dollars against about a 1k reservation: nothing to block.
      expect(isOverCap(3_006, 50_000_000)).toBe(false);
      expect(isOverCap(50_000_000, 50_000_000)).toBe(false);
      expect(isOverCap(50_000_001, 50_000_000)).toBe(true);
      for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
        expect(isOverCap(bad, 5)).toBe(false);
        expect(isOverCap(5, bad)).toBe(false);
      }
      expect(MODEL_EGRESS_OVERRUN_SENTENCE).toBe("budget exceeded by one call");
      expect(dec(refusalResponse("gemini", "cap", { capMicros: 2_000_000, overrun: true }).body)).toContain("budget exceeded by one call");
      expect(dec(refusalResponse("gemini", "cap", { capMicros: 2_000_000 }).body)).not.toContain("exceeded by one call");
    });
    it("splices the row's default maximum into the ORIGINAL text when the request names none, and leaves one it set alone", () => {
      const inject = (family: ModelEgressFamily, operation: string, text: string, field?: "max_tokens" | "max_completion_tokens") => {
        const result = withDefaultMaxOutput(family, operation, enc(text), 777, field);
        return { text: dec(result.body), injected: result.injected };
      };
      expect(inject("openai_compatible", "chat/completions", '{"model":"m","messages":[]}').text).toBe('{"model":"m","messages":[],"max_tokens":777}');
      expect(inject("openai_compatible", "chat/completions", '{"model":"m"}', "max_completion_tokens").text).toBe('{"model":"m","max_completion_tokens":777}');
      expect(inject("openai_compatible", "chat/completions", "{}").text).toBe('{"max_tokens":777}');
      expect(inject("openai_compatible", "responses", '{"input":"x"}').text).toBe('{"input":"x","max_output_tokens":777}');
      expect(inject("cohere", "chat", '{"messages":[]}').text).toBe('{"messages":[],"max_tokens":777}');
      expect(inject("gemini", "generateContent", '{"contents":[]}').text).toBe('{"contents":[],"generationConfig":{"maxOutputTokens":777}}');
      expect(inject("vertex", "streamGenerateContent", '{"contents":[],"generationConfig":{"temperature":0.2}}').text).toBe('{"contents":[],"generationConfig":{"temperature":0.2,"maxOutputTokens":777}}');
      expect(inject("gemini", "generateContent", '{"generation_config":{"temperature":0.2}}').text).toBe('{"generation_config":{"temperature":0.2,"max_output_tokens":777}}');
      for (const [family, operation, text] of [
        ["openai_compatible", "chat/completions", '{"max_tokens":5}'], ["openai_compatible", "chat/completions", '{"max_completion_tokens":5}'], ["openai_compatible", "responses", '{"max_output_tokens":5}'],
        ["gemini", "generateContent", '{"generationConfig":{"maxOutputTokens":9}}'], ["gemini", "generateContent", '{"generation_config":{"max_output_tokens":9}}'], ["gemini", "generateContent", '{"generationConfig":{"max_output_tokens":9}}'],
        ["cohere", "chat", '{"max_tokens":3}'],
      ] as const) {
        expect(inject(family, operation, text), `${family} ${text}`).toEqual({ text, injected: false });
      }
      for (const [family, operation, text] of [["openai_compatible", "embeddings", '{"input":"x"}'], ["gemini", "countTokens", "{}"], ["gemini", "embedContent", "{}"], ["anthropic_messages", "messages", '{"model":"m"}'], ["cohere", "embed", "{}"], ["cohere", "rerank", "{}"]] as const) {
        expect(inject(family, operation, text).injected, `${family} ${operation}`).toBe(false);
      }
    });
    it("keeps every other byte the client sent: big integers, number spelling, key order, white space, escapes and odd keys (review L3)", () => {
      const inject = (text: string) => dec(withDefaultMaxOutput("openai_compatible", "chat/completions", enc(text), 777).body);
      const cases = [
        '{"model":"m","seed":12345678901234567890,"messages":[]}',
        '{"model":"m","temperature":1.0,"top_p":0.10,"x":-0,"y":1E2,"z":1e400}',
        '{"model":"m","response_format":{"json_schema":{"properties":{"b":1,"2":1,"a":1,"1":1}}}}',
        '{ "model" : "m" ,\n "messages" : [ ] }',
        '{"model":"m","__proto__":{"max_tokens":5},"messages":[]}',
        '{"model":"m","x":"\\ud800","y":"\\u00e9\\n"}',
        '{"model":"m","model":"other","messages":[]}',
        '{"model":"m","nested":{"max_tokens":5,"max_completion_tokens":1}}',
      ];
      for (const text of cases) {
        const result = inject(text);
        // The result is the original with ONE member appended: nothing before the closing brace moved.
        const closing = text.lastIndexOf("}");
        expect(result.startsWith(text.slice(0, closing).trimEnd() === "" ? "" : text.slice(0, closing)), text).toBe(true);
        expect(result, text).toBe(`${text.slice(0, closing)},"max_tokens":777}`);
        expect(JSON.parse(result)).toBeTypeOf("object");
      }
      expect(inject("   \n{\"model\":\"m\"}  ")).toBe('   \n{"model":"m","max_tokens":777}  ');
    });
    it("overwrites a present but unusable maximum, and a usable one is never touched (review L4)", () => {
      const inject = (family: ModelEgressFamily, operation: string, text: string) => dec(withDefaultMaxOutput(family, operation, enc(text), 777).body);
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":null}')).toBe('{"max_tokens":777}');
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":"60000"}')).toBe('{"max_tokens":777}');
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":0,"model":"m"}')).toBe('{"max_tokens":777,"model":"m"}');
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":-5}')).toBe('{"max_tokens":777}');
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":5,"max_completion_tokens":2000000000}')).toBe('{"max_tokens":5,"max_completion_tokens":5}');
      expect(inject("openai_compatible", "chat/completions", '{"max_tokens":5,"max_tokens":2000000000}')).toBe('{"max_tokens":5,"max_tokens":5}');
      // A different case is a different key to the provider: unnamed, so the field is added (the stray key means nothing to anyone).
      expect(inject("openai_compatible", "chat/completions", '{"MAX_TOKENS":999999}')).toBe('{"MAX_TOKENS":999999,"max_tokens":777}');
      // Google reads snake_case too: a snake_case maximum is a NAMED maximum, and a second config is never added.
      const snake = inject("gemini", "generateContent", '{"generation_config":{"max_output_tokens":60000}}');
      expect(snake).toBe('{"generation_config":{"max_output_tokens":60000}}');
      expect(inject("gemini", "generateContent", '{"generationConfig":{"maxOutputTokens":null}}')).toBe('{"generationConfig":{"maxOutputTokens":777}}');
      expect(inject("gemini", "generateContent", '{"generationConfig":{"maxOutputTokens":"60000"}}')).toBe('{"generationConfig":{"maxOutputTokens":777}}');
      expect(inject("gemini", "generateContent", '{"generationConfig":"x"}')).toBe('{"generationConfig":{"maxOutputTokens":777}}');
      expect(inject("gemini", "generateContent", '{"generationConfig":[]}')).toBe('{"generationConfig":{"maxOutputTokens":777}}');
      expect(inject("gemini", "generateContent", '{"generation_config":null}')).toBe('{"generation_config":{"max_output_tokens":777}}');
      // Both configs present, one usable: both end up saying the usable figure.
      expect(inject("gemini", "generateContent", '{"generationConfig":{"maxOutputTokens":null},"generation_config":{"max_output_tokens":60000}}')).toBe('{"generationConfig":{"maxOutputTokens":60000},"generation_config":{"max_output_tokens":60000}}');
      for (const text of ['{"contents":[]}', '{"generation_config":{"temperature":1}}', '{"generationConfig":{"max_output_tokens":null}}', '{"generationConfig":"x"}']) {
        const out = inject("gemini", "generateContent", text);
        expect((out.match(/generationConfig|generation_config/gu) ?? []).length, text).toBe(1);
      }
    });
    it("leaves a body that is not UTF-8 JSON, or not an object, exactly as it is", () => {
      for (const bytes of [enc("not json"), enc("[1,2]"), enc("5"), enc(""), new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
        const result = withDefaultMaxOutput("openai_compatible", "chat/completions", bytes, 777);
        expect(result.injected).toBe(false);
        expect(result.body).toBe(bytes);
      }
    });
    it("names the chat field per row: max_completion_tokens for openai and azure-openai, max_tokens for the others, a row setting wins", () => {
      expect(maxOutputFieldOf({ id: "openai" })).toBe("max_completion_tokens");
      expect(maxOutputFieldOf({ id: "azure-openai" })).toBe("max_completion_tokens");
      for (const id of ["openrouter", "mistral", "groq", "together", "gemini-openai", "my-gateway"]) expect(maxOutputFieldOf({ id })).toBe("max_tokens");
      expect(maxOutputFieldOf({ id: "openai", maxOutputField: "max_tokens" })).toBe("max_tokens");
      expect(maxOutputFieldOf({ id: "my-gateway", maxOutputField: "max_completion_tokens" })).toBe("max_completion_tokens");
    });
    it("reserves the HIGHEST plausible maximum when a body names several (duplicate or conflicting fields)", () => {
      expect(requestedMaxOutputTokens("openai_compatible", enc('{"max_tokens":10,"max_completion_tokens":0}'))).toBe(10);
      expect(requestedMaxOutputTokens("openai_compatible", enc('{"max_tokens":10,"max_completion_tokens":4000}'))).toBe(4000);
      expect(requestedMaxOutputTokens("openai_compatible", enc('{"max_tokens":4000,"max_completion_tokens":10,"max_output_tokens":20}'))).toBe(4000);
    });
  });
  describe("a count over 10^10 uses the reservation and never zero (review L5)", () => {
    const row = { prices: [{ model: "m", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }], defaultMaxOutputTokens: 1000, fallbackPrice: undefined };
    it("an implausible reported count is not read as zero usage", () => {
      for (const body of [{ usage: { prompt_tokens: 10, completion_tokens: 2e10 } }, { usage: { prompt_tokens: 3e10, completion_tokens: 5 } }, { usage: { prompt_tokens: -5, completion_tokens: 3 } }]) {
        expect(usageFromBody("openai_compatible", JSON.stringify(body)), JSON.stringify(body)).toBeUndefined();
      }
      const reservation = reserveEstimate({ row, model: "m", inputBytes: 4_000, maxOutputTokens: 2_000 });
      const usage = usageFromBody("openai_compatible", JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2e10 } }));
      expect(settleCost({ reservation, usage, complete: true })).toEqual({ costMicros: reservation.reserveMicros, estimated: true, aboveReservation: false });
      expect(reservation.reserveMicros).toBeGreaterThan(0);
    });
    it("a count over the bound in ONE field keeps the figure of the other field out of the settle too", () => {
      const partial = usageFromBody("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3e10 } }));
      const reservation = reserveEstimate({ row, model: "m", inputBytes: 400, maxOutputTokens: 100 });
      const settled = settleCost({ reservation, usage: partial, complete: true });
      expect(settled.costMicros).toBe(reservation.reserveMicros);
      expect(settled.estimated).toBe(true);
    });
  });
});
