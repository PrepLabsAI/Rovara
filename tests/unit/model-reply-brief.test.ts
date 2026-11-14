// TE-R2 part A: the brief. Built from an allow-list (no header, query, key, id or unknown field), bounded, masked, the prompt hash equal to what `selectModelReply` compares, registered so the channel can refuse a look-alike.
import { describe, expect, it } from "vitest";
import {
  REPLY_BRIEF_MAX_TOOLS,
  REPLY_BRIEF_PROMPT_MAX_BYTES,
  extractReplyBrief,
  isReplyBrief,
  parseReplyBrief,
  promptsWithConflictingShapes,
  replyRequestData,
  selectModelReply,
  sha256HexOf,
  type ModelReplySet,
  type ReplyBrief,
} from "@agentx/contracts";

const fakeKey = (): string => `${"sk"}-${"Ab1".repeat(14)}`;
const must = (result: ReturnType<typeof extractReplyBrief>): ReplyBrief => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.brief;
};
const openAi = (extra: Record<string, unknown> = {}, content = "Summarize the quarterly report in one line.") => JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content }], ...extra });
const PROMPT_TEXT = "Summarize the quarterly report in one line.";
const CANARY = "CANARY-FIELD-7f3a";

describe("what the brief holds", () => {
  it("holds the prompt, the shape, family, operation and model, and no other body field (allow-list, not copy)", () => {
    const body = openAi({ api_key: CANARY, user: CANARY, metadata: { trace: CANARY }, temperature: 0.2, headers: { authorization: CANARY }, url: `https://x.test/${CANARY}`, request_id: CANARY, max_tokens: 200 });
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", body));
    const text = JSON.stringify(brief);
    expect(text).not.toContain(CANARY);
    expect(Object.keys(brief).sort()).toEqual(["family", "model", "operation", "promptMasked", "promptSha256", "promptText", "shape", "shapeSha256"]);
    expect(brief).toMatchObject({ family: "openai_compatible", operation: "chat_completions", model: "gpt-4o", promptText: "Summarize the quarterly report in one line.", shape: { kind: "text", stream: false, maxOutputTokens: 200 } });
    expect(Object.keys(brief.shape).sort()).toEqual(["kind", "maxOutputTokens", "stream"]);
  });

  it("promptSha256 is exactly what selectModelReply compares (pinned against the real selection)", () => {
    const body = openAi();
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", body));
    const set: ModelReplySet = {
      version: 1,
      family: "openai_compatible",
      replies: [{ id: "r1", match: { operation: "chat_completions", model: "gpt-4o", promptSha256: brief.promptSha256 }, response: { text: "ok", finish: "stop" }, provenance: "task_made" }],
    };
    const picked = selectModelReply(set, { model: "gpt-4o", operation: "chat_completions", promptText: "Summarize the quarterly report in one line." }, new Map(), "openai_compatible");
    expect(picked.reply?.id).toBe("r1");
    expect(brief.promptSha256).toBe(sha256HexOf(new TextEncoder().encode("Summarize the quarterly report in one line.")));
  });

  it("masks credential-shaped text for the agent but hashes the prompt as the helper read it", () => {
    const key = fakeKey();
    const prompt = `Use the key ${key} to call the API.`;
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({}, prompt)));
    expect(brief.promptText).not.toContain(key);
    expect(brief.promptMasked).toBe(true);
    expect(brief.promptSha256).toBe(sha256HexOf(new TextEncoder().encode(prompt)));
    expect(must(extractReplyBrief("openai_compatible", "chat_completions", openAi())).promptMasked).toBe(false);
  });

  it("masks a credential inside a tool description and a schema string", () => {
    const key = fakeKey();
    const body = openAi({ tools: [{ type: "function", function: { name: "lookup", description: `call with ${key}`, parameters: { type: "object", properties: { q: { type: "string", description: `token ${key}` } } } } }] });
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", body));
    expect(JSON.stringify(brief)).not.toContain(key);
    expect(brief.promptMasked).toBe(true);
  });

  it("uses the route's model for Gemini (the path names it, the body does not)", () => {
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say hi" }] }] });
    expect(must(extractReplyBrief("gemini", "generateContent", body, { model: "gemini-2.5-flash" })).model).toBe("gemini-2.5-flash");
    expect(must(extractReplyBrief("gemini", "generateContent", body)).model).toBeUndefined();
  });
});

describe("the declared answer shape, per family", () => {
  it("OpenAI json_schema (and a bare json_object)", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ response_format: { type: "json_schema", json_schema: { name: "t", schema } } })));
    expect(brief.shape).toMatchObject({ kind: "json", jsonSchema: schema });
    expect(must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ response_format: { type: "json_object" } }))).shape).toMatchObject({ kind: "json" });
  });
  it("OpenAI tools, with and without a forced tool, and tool_choice none", () => {
    const tools = [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
    const auto = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools })));
    expect(auto.shape).toMatchObject({ kind: "tool_call", toolsRequired: false, tools: [{ name: "get_weather" }] });
    const forced = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools, tool_choice: { type: "function", function: { name: "get_weather" } } })));
    expect(forced.shape).toMatchObject({ toolsRequired: true, forcedToolName: "get_weather" });
    expect(must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools, tool_choice: "none" }))).shape.kind).toBe("text");
    expect(must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools, tool_choice: "required" }))).shape.toolsRequired).toBe(true);
  });
  it("Responses API (text.format and flat tools)", () => {
    const body = JSON.stringify({ model: "gpt-4o", input: "Classify this", text: { format: { type: "json_schema", name: "c", schema: { type: "object", properties: { label: { type: "string" } } } } } });
    expect(must(extractReplyBrief("openai_compatible", "responses", body)).shape).toMatchObject({ kind: "json", jsonSchema: { type: "object" } });
    const withTools = JSON.stringify({ model: "gpt-4o", input: "go", tools: [{ type: "function", name: "run", parameters: { type: "object" } }, { type: "web_search_preview" }] });
    expect(must(extractReplyBrief("openai_compatible", "responses", withTools)).shape.tools?.map((tool) => tool.name)).toEqual(["run"]);
  });
  it("Anthropic tools, tool_choice any and max_tokens", () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 512, messages: [{ role: "user", content: "Look it up" }], tools: [{ name: "search", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "any" } });
    const brief = must(extractReplyBrief("anthropic_messages", "messages", body));
    expect(brief.shape).toMatchObject({ kind: "tool_call", toolsRequired: true, maxOutputTokens: 512, tools: [{ name: "search" }] });
    expect(brief.shape.tools).toHaveLength(1);
  });
  it("Gemini responseSchema, responseMimeType and functionDeclarations (camelCase and snake_case)", () => {
    const schema = { type: "OBJECT", properties: { n: { type: "NUMBER" } } };
    const camel = JSON.stringify({ contents: [{ parts: [{ text: "count" }] }], generationConfig: { responseSchema: schema, maxOutputTokens: 99 } });
    expect(must(extractReplyBrief("gemini", "generateContent", camel)).shape).toMatchObject({ kind: "json", jsonSchema: schema, maxOutputTokens: 99 });
    const mime = JSON.stringify({ contents: [{ parts: [{ text: "x" }] }], generation_config: { response_mime_type: "application/json" } });
    expect(must(extractReplyBrief("gemini", "generateContent", mime)).shape.kind).toBe("json");
    const tools = JSON.stringify({ contents: [{ parts: [{ text: "x" }] }], tools: [{ function_declarations: [{ name: "f1", description: "d", parameters: { type: "OBJECT" } }] }], tool_config: { function_calling_config: { mode: "ANY" } } });
    expect(must(extractReplyBrief("gemini", "generateContent", tools)).shape).toMatchObject({ kind: "tool_call", toolsRequired: true });
    expect(must(extractReplyBrief("gemini", "streamGenerateContent", camel)).shape.stream).toBe(true);
  });
  it("Cohere response_format and tools", () => {
    const body = JSON.stringify({ model: "command-r", messages: [{ role: "user", content: "x" }], response_format: { type: "json_object", json_schema: { type: "object", properties: { a: { type: "string" } } } } });
    expect(must(extractReplyBrief("cohere", "chat", body)).shape).toMatchObject({ kind: "json", jsonSchema: { type: "object" } });
  });
  it("embeddings and rerank get no brief (they would only use up the capture cap), and neither do models and token counts", () => {
    for (const [family, operation, body] of [
      ["openai_compatible", "embeddings", JSON.stringify({ model: "text-embedding-3-small", input: "hello world" })],
      ["cohere", "rerank", JSON.stringify({ model: "rerank-v3", query: "q", documents: ["a", "b"] })],
      ["cohere", "embed", JSON.stringify({ model: "e", texts: ["a b c"] })],
      ["gemini", "embedContent", JSON.stringify({ content: { parts: [{ text: "x y z" }] } })],
      ["gemini", "batchEmbedContents", JSON.stringify({ requests: [{ content: { parts: [{ text: "x y z" }] } }] })],
      ["openai_compatible", "models", "{}"],
      ["gemini", "countTokens", JSON.stringify({ contents: [{ parts: [{ text: "x" }] }] })],
      ["anthropic_messages", "chat_completions", "{}"],
    ] as const) {
      expect(extractReplyBrief(family, operation, body), `${family} ${operation}`).toEqual({ ok: false, reason: "unsupported_operation" });
    }
  });
});

describe("bounds and refusals", () => {
  it("a prompt over 64 KiB is too_long; exactly 64 KiB is fine", () => {
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({}, "x".repeat(REPLY_BRIEF_PROMPT_MAX_BYTES + 1)))).toEqual({ ok: false, reason: "too_long" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({}, "x".repeat(REPLY_BRIEF_PROMPT_MAX_BYTES))).ok).toBe(true);
    // bytes, not characters: 3-byte characters
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({}, "€".repeat(Math.ceil(REPLY_BRIEF_PROMPT_MAX_BYTES / 3) + 1)))).toEqual({ ok: false, reason: "too_long" });
  });
  it("a body that is not a JSON object, or has no prompt, is refused", () => {
    expect(extractReplyBrief("openai_compatible", "chat_completions", "not json")).toEqual({ ok: false, reason: "not_json" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", "[1]")).toEqual({ ok: false, reason: "not_json" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m" }))).toEqual({ ok: false, reason: "no_prompt" });
  });
  it("a schema over 16 KiB, deeper than 16, or with a __proto__ key is bad_schema", () => {
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`field_${index}`, { type: "string", description: "x".repeat(20) }])) };
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ response_format: { type: "json_schema", json_schema: { schema: wide } } }))).toEqual({ ok: false, reason: "bad_schema" });
    let deep: Record<string, unknown> = { type: "string" };
    for (let level = 0; level < 20; level += 1) deep = { type: "object", properties: { a: deep } };
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ response_format: { type: "json_schema", json_schema: { schema: deep } } }))).toEqual({ ok: false, reason: "bad_schema" });
    const proto = `{"model":"m","messages":[{"role":"user","content":"hi there"}],"response_format":{"type":"json_schema","json_schema":{"schema":{"type":"object","__proto__":{"polluted":true}}}}}`;
    expect(extractReplyBrief("openai_compatible", "chat_completions", proto)).toEqual({ ok: false, reason: "bad_schema" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("too many tools, or a tool with a bad name, is refused", () => {
    const many = Array.from({ length: REPLY_BRIEF_MAX_TOOLS + 1 }, (_, index) => ({ type: "function", function: { name: `t${index}`, parameters: { type: "object" } } }));
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools: many }))).toEqual({ ok: false, reason: "bad_tools" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ tools: [{ type: "function", function: { name: "bad name!", parameters: {} } }] }))).toEqual({ ok: false, reason: "bad_tools" });
  });
  it("a tool description is cut at 2 KiB", () => {
    const body = openAi({ tools: [{ type: "function", function: { name: "t", description: "d".repeat(10_000), parameters: { type: "object" } } }] });
    expect(must(extractReplyBrief("openai_compatible", "chat_completions", body)).shape.tools?.[0]?.description).toHaveLength(2_048);
  });
  it("a 1 MB body is refused fast", () => {
    const started = Date.now();
    const result = extractReplyBrief("openai_compatible", "chat_completions", openAi({}, "y".repeat(1_000_000)));
    expect(result).toEqual({ ok: false, reason: "too_long" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("registration", () => {
  it("a brief from extractReplyBrief is registered; a spread copy and a literal are not", () => {
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi()));
    expect(isReplyBrief(brief)).toBe(true);
    expect(isReplyBrief({ ...brief })).toBe(false);
    expect(isReplyBrief({ family: "gemini" })).toBe(false);
  });
  it("parseReplyBrief round-trips a written-down brief, and refuses an unknown key, an oversize prompt, a bad operation and a schema with __proto__", () => {
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({ response_format: { type: "json_object" } })));
    const written = JSON.parse(JSON.stringify(brief)) as Record<string, unknown>;
    const back = parseReplyBrief(written);
    expect(back.ok && isReplyBrief(back.brief)).toBe(true);
    expect(back.ok && back.brief).toEqual(brief);
    expect(parseReplyBrief({ ...written, extra: CANARY }).ok).toBe(false);
    expect(parseReplyBrief({ ...written, promptText: "x".repeat(REPLY_BRIEF_PROMPT_MAX_BYTES + 1) }).ok).toBe(false);
    expect(parseReplyBrief({ ...written, operation: "models" }).ok).toBe(false);
    expect(parseReplyBrief({ ...written, operation: "embeddings" }).ok).toBe(false);
    const evil = JSON.parse(`{"type":"object","__proto__":{"x":1}}`) as unknown;
    expect(parseReplyBrief({ ...written, shape: { kind: "json", stream: false, jsonSchema: evil } }).ok).toBe(false);
    expect(parseReplyBrief({ ...written, shape: { kind: "text", stream: false, tools: [{ name: "t" }] } }).ok).toBe(false);
    expect(parseReplyBrief(null).ok).toBe(false);
  });
});

describe("the prompt hash is tied to the prompt text when a brief is read back (M3)", () => {
  const written = (content = PROMPT_TEXT): Record<string, unknown> => {
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi({}, content)));
    return JSON.parse(JSON.stringify(brief)) as Record<string, unknown>;
  };
  it("an unmasked brief must hash to its promptSha256: a forged hash is refused", () => {
    expect(parseReplyBrief(written()).ok).toBe(true);
    expect(parseReplyBrief({ ...written(), promptSha256: "a".repeat(64) }).ok).toBe(false);
    expect(parseReplyBrief({ ...written(), promptText: "harmless greeting" }).ok).toBe(false);
  });
  it("a masked brief carries the hash of its masked text and it must match; a mismatch is refused", () => {
    const masked = written(`Use the key ${fakeKey()} to call the API.`);
    expect(masked.promptMasked).toBe(true);
    expect(typeof masked.promptMaskedSha256).toBe("string");
    expect(parseReplyBrief(masked).ok).toBe(true);
    expect(parseReplyBrief({ ...masked, promptMaskedSha256: "b".repeat(64) }).ok).toBe(false);
    const without = { ...masked };
    delete without.promptMaskedSha256;
    expect(parseReplyBrief(without).ok).toBe(false);
    expect(parseReplyBrief({ ...masked, promptText: "something else entirely" }).ok).toBe(false);
  });
  it("an unmasked brief carries no masked-text hash", () => {
    expect(parseReplyBrief({ ...written(), promptMaskedSha256: "c".repeat(64) }).ok).toBe(false);
    expect(written()).not.toHaveProperty("promptMaskedSha256");
  });
  it("a masked schema with an unmasked prompt still ties the prompt hash directly", () => {
    const body = openAi({ tools: [{ type: "function", function: { name: "t", description: `call with ${fakeKey()}`, parameters: { type: "object" } } }] });
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", body));
    expect(brief.promptMasked).toBe(true);
    expect(brief.promptMaskedSha256).toBeUndefined();
    expect(parseReplyBrief(JSON.parse(JSON.stringify(brief))).ok).toBe(true);
  });
});

describe("the shape digest (M5)", () => {
  const digest = (body: unknown): string => must(extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify(body))).shapeSha256;
  const messages = (...roles: [string, string][]) => roles.map(([role, content]) => ({ role, content }));
  it("the same prompt text with another role layout, tools or schema gets another digest; the same request gets the same", () => {
    const a = digest({ model: "m", messages: messages(["system", "Be terse"], ["user", "Hi"]) });
    const b = digest({ model: "m", messages: messages(["user", "Be terse\nHi"]) });
    const c = digest({ model: "m", messages: messages(["user", "Be terse"], ["assistant", "Hi"]) });
    const d = digest({ model: "m", messages: messages(["user", "Be terse\nHi"]), tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }], tool_choice: "required" });
    const e = digest({ model: "m", messages: messages(["user", "Be terse\nHi"]), response_format: { type: "json_object" } });
    expect(new Set([a, b, c, d, e]).size).toBe(5);
    expect(digest({ model: "m", messages: messages(["system", "Be terse"], ["user", "Hi"]) })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });
  it("the same prompt hash with two shape digests is listed as conflicting (the capture step refuses to count it)", () => {
    const one = must(extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m", messages: messages(["system", "Be terse"], ["user", "Hi"]) })));
    const two = must(extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m", messages: messages(["user", "Be terse\nHi"]) })));
    const other = must(extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m", messages: messages(["user", "something else entirely"]) })));
    expect(one.promptSha256).toBe(two.promptSha256);
    expect([...promptsWithConflictingShapes([one, two, other])]).toEqual([one.promptSha256]);
    expect([...promptsWithConflictingShapes([one, one, other])]).toEqual([]);
  });
});

describe("the model name (L3)", () => {
  it("a model name that cannot be put in a match refuses the brief; it is not silently dropped", () => {
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ model: "bad model name!" }))).toEqual({ ok: false, reason: "bad_model" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi(), { model: "bad model name!" })).toEqual({ ok: false, reason: "bad_model" });
    expect(extractReplyBrief("openai_compatible", "chat_completions", openAi({ model: 42 }))).toEqual({ ok: false, reason: "bad_model" });
    expect(extractReplyBrief("gemini", "generateContent", JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] })).ok).toBe(true);
  });
});

describe("what the agent is sent", () => {
  it("replyRequestData is the one description of the request: family, operation, model, prompt and shape", () => {
    const brief = must(extractReplyBrief("openai_compatible", "chat_completions", openAi()));
    expect(replyRequestData(brief)).toEqual({ family: "openai_compatible", operation: "chat_completions", model: "gpt-4o", prompt: PROMPT_TEXT, answerShape: brief.shape });
  });
});
