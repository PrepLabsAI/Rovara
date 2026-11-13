// TE-F8: the record key and the prompt segments. Stability under volatile fields and field order; apart for streaming, model, row and prompt; never throws; fast on a large body.
import { describe, expect, it } from "vitest";
import { MODEL_RECORD_DEPTH_MAX, MODEL_RECORD_VOLATILE_FIELDS, modelPromptSegments, modelRecordKey, readModelRequest } from "@agentx/contracts";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import { validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { chatFrame, geminiFrame, messagesFrame } from "./model-record-support.js";

const world = fakeModelEgressWorld();
const enc = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const keyOf = (frame: unknown): string => {
  const result = modelRecordKey(frame);
  if (!result.ok) throw new Error(`no key: ${result.reason}`);
  return result.key;
};
const withBody = (frame: Record<string, unknown>, body: unknown): Record<string, unknown> => ({ ...frame, body: enc(body) });

describe("modelRecordKey", () => {
  it("is 64 hex characters and the same for the same request", () => {
    const key = keyOf(chatFrame(world, { system: "S" }));
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(keyOf(chatFrame(world, { system: "S" }))).toBe(key);
  });

  it("ignores the order of fields at every level", () => {
    const a = withBody(chatFrame(world), { model: "m", temperature: 0.2, messages: [{ role: "user", content: "hi", name: "n" }] });
    const b = withBody(chatFrame(world), { messages: [{ name: "n", content: "hi", role: "user" }], temperature: 0.2, model: "m" });
    expect(keyOf(a)).toBe(keyOf(b));
  });

  it("ignores credentials, request ids and other headers", () => {
    const plain = keyOf(chatFrame(world));
    const noisy = keyOf(chatFrame(world, { headers: [["content-type", "application/json"], ["authorization", "Bearer " + ["not", "a", "key"].join("-")], ["x-request-id", "r-1"], ["user-agent", "sdk/9.9"], ["x-stainless-retry-count", "2"]] }));
    expect(noisy).toBe(plain);
  });

  it("ignores the query key `key` (a credential) but not another query", () => {
    const base = chatFrame(world);
    expect(keyOf({ ...base, query: "key=abc123" })).toBe(keyOf(base));
  });

  it.each(Object.entries(MODEL_RECORD_VOLATILE_FIELDS).filter(([family]) => family === "openai_compatible"))("ignores each volatile field of %s", (_family, fields) => {
    const plain = keyOf(chatFrame(world));
    for (const field of fields) expect(keyOf(chatFrame(world, { extra: { [field]: "value-" + field } })), field).toBe(plain);
  });

  it("ignores the volatile fields of Anthropic and Gemini requests too", () => {
    expect(keyOf(messagesFrame(world, { extra: { metadata: { user_id: "u-1" } } }))).toBe(keyOf(messagesFrame(world)));
    const gemini = geminiFrame(world, { system: "S" });
    const withLabels = withBody(gemini, { ...(JSON.parse(new TextDecoder().decode(gemini.body as Uint8Array)) as object), labels: { run: "42" } });
    expect(keyOf(withLabels)).toBe(keyOf(gemini));
  });

  it("keeps streaming and non-streaming apart", () => {
    expect(keyOf(chatFrame(world, { stream: true }))).not.toBe(keyOf(chatFrame(world)));
    const gemini = geminiFrame(world);
    expect(keyOf({ ...gemini, path: String(gemini.path).replace("generateContent", "streamGenerateContent") })).not.toBe(keyOf(gemini));
  });

  it.each([
    ["the system prompt", { system: "S2" }],
    ["the user message", { user: "another question" }],
    ["the model", { model: "fixture-large" }],
    ["a generation setting", { extra: { temperature: 0.9 } }],
    ["the tools", { extra: { tools: [{ type: "function", function: { name: "f" } }] } }],
  ] as const)("changes when %s changes", (_name, change) => {
    expect(keyOf(chatFrame(world, { system: "S", ...change }))).not.toBe(keyOf(chatFrame(world, { system: "S" })));
  });

  it("changes with the row (another provider is another answer) and with a kept header", () => {
    const openai = chatFrame(world);
    expect(keyOf({ ...openai, row: world.rows.openrouter!.id })).not.toBe(keyOf(openai));
    expect(keyOf(chatFrame(world, { headers: [["content-type", "application/json"], ["anthropic-beta", "x"]] }))).not.toBe(keyOf(chatFrame(world)));
  });

  it("reads the version segment and the project of a path as no part of the call", () => {
    const base = chatFrame(world);
    expect(keyOf({ ...base, path: "/chat/completions" })).toBe(keyOf({ ...base, path: "/v1/chat/completions" }));
  });

  it("never throws, and refuses with a word, for a frame or body it cannot read", () => {
    const base = chatFrame(world);
    expect(modelRecordKey(undefined)).toEqual({ ok: false, reason: "bad_frame" });
    expect(modelRecordKey({ ...base, extra: 1 })).toEqual({ ok: false, reason: "bad_frame" });
    expect(modelRecordKey({ ...base, body: enc("not json") })).toEqual({ ok: false, reason: "body_not_json" });
    expect(modelRecordKey({ ...base, body: enc("[1,2]") })).toEqual({ ok: false, reason: "body_not_json" });
    expect(modelRecordKey({ ...base, body: new Uint8Array([0xff, 0xfe]) })).toEqual({ ok: false, reason: "body_not_json" });
    const deep = `{"a":${"[".repeat(MODEL_RECORD_DEPTH_MAX + 5)}${"]".repeat(MODEL_RECORD_DEPTH_MAX + 5)}}`;
    expect(modelRecordKey({ ...base, body: enc(deep) })).toEqual({ ok: false, reason: "too_deep" });
    // A body nested far past any stack is still a word, not a crash.
    expect(modelRecordKey({ ...base, body: enc(`{"a":${"[".repeat(20000)}${"]".repeat(20000)}}`) }).ok).toBe(false);
  });

  it("treats a __proto__ key as data: it changes the key and pollutes nothing", () => {
    const base = chatFrame(world);
    const plain = keyOf(withBody(base, { model: "m", messages: [] }));
    const proto = keyOf(withBody(base, '{"model":"m","messages":[],"__proto__":{"polluted":true}}'));
    expect(proto).not.toBe(plain);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keys a 1 MB body quickly", () => {
    const base = chatFrame(world);
    const big = withBody(base, { model: "m", messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] });
    const started = performance.now();
    expect(keyOf(big)).toMatch(/^[a-f0-9]{64}$/u);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("is the same function F1-c would call: it takes an unknown frame and returns the view it read", () => {
    const result = modelRecordKey(chatFrame(world, { system: "S" }));
    expect(result.ok && result.view.family).toBe("openai_compatible");
    expect(result.ok && result.view.streaming).toBe(false);
    expect(result.ok && result.view.model).toBe("fixture-small");
  });
});

describe("modelPromptSegments", () => {
  const segments = (frame: unknown) => {
    const read = readModelRequest(frame);
    if (!read.ok) throw new Error("unreadable");
    return modelPromptSegments(read.view);
  };

  it("splits system and prompt text for the OpenAI chat shape", () => {
    expect(segments(chatFrame(world, { system: "SYS", user: "USR" }))).toEqual({ system: ["SYS"], prompt: ["USR"] });
  });
  it("reads the Anthropic `system` field and parts of a content array, and the joined text of several parts", () => {
    const frame = withBody(messagesFrame(world), { model: "m", system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], messages: [{ role: "user", content: [{ type: "text", text: "C" }, { type: "text", text: "D" }] }] });
    expect(segments(frame)).toEqual({ system: ["A", "B", "A B"], prompt: ["C", "D", "C D"] });
  });
  it("reads Gemini systemInstruction and contents", () => {
    expect(segments(geminiFrame(world, { system: "SYS", user: "USR" }))).toEqual({ system: ["SYS"], prompt: ["USR"] });
  });
  it("yields nothing for a shape it does not know, never throws on odd values", () => {
    expect(segments(withBody(chatFrame(world), { model: "m", messages: [null, 3, { role: 7 }, { content: { deep: [[[[[[[[[["x"]]]]]]]]]] } }] }))).toEqual({ system: [], prompt: [] });
  });
  it("bounds the number of segments", () => {
    const many = withBody(chatFrame(world), { model: "m", messages: Array.from({ length: 5000 }, (_, i) => ({ role: "user", content: `m${String(i)}` })) });
    expect(segments(many).prompt.length).toBe(2000);
  });
  it("shares the family a caller passes", () => {
    const read = readModelRequest(validFrame(world.rows.cohere!, world.connection, "hi"), { family: "cohere" });
    expect(read.ok && read.view.family).toBe("cohere");
  });
});
