// TE-F2 part A: the reply-set schema (strict, bounded, `__proto__` safe), the author-side file form that carries NO provenance, the stamp the worker applies, the stable digest, and the first-match-wins selection with `sequence`.
import { describe, expect, it } from "vitest";
import { MODEL_REPLY_SET_MAX_BYTES, MODEL_REPLY_SET_MAX_REPLIES, ModelReplySetFileSchema, ModelReplySetSchema, type IndependentReplyDecision, type ReplyProvenanceDecision, createRovaraIndependentDecision, modelReplyEntrySha256, modelReplySetDigest, parseModelReplySetFileBytes, parseModelReplySetBytes, selectModelReply, stampReplyProvenance } from "../../packages/contracts/src/model-reply-set.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const fileReply = (id: string, over: Record<string, unknown> = {}) => ({ id, match: {}, response: { text: `answer ${id}`, finish: "stop" }, ...over });
const fileSet = (replies: unknown[] = [fileReply("a")], family = "gemini") => ({ version: 1, family, replies });
const stamped = (replies: Record<string, unknown>[], family = "gemini") => ({ version: 1, family, replies: replies.map((reply) => ({ provenance: "before_task", origin: "customer_written", ...reply })) });

describe("the file form (what a repo file may hold)", () => {
  it("a __proto__ key never reaches an object and is refused at every level", () => {
    const polluted = (): unknown => (({}) as Record<string, unknown>).polluted;
    const texts = [
      '{"version":1,"family":"gemini","replies":[],"__proto__":{"polluted":true}}',
      '{"version":1,"family":"gemini","replies":[{"id":"a","match":{"__proto__":{"polluted":true}},"response":{"text":"x","finish":"stop"}}]}',
      '{"version":1,"family":"gemini","replies":[{"id":"a","match":{},"response":{"__proto__":{"polluted":true},"text":"x","finish":"stop"}}]}',
      '{"version":1,"family":"gemini","replies":[{"id":"a","match":{},"response":{"text":"x","finish":"stop","toolCalls":[{"name":"n","args":{"__proto__":{"polluted":true}}}]}}]}',
      '{"version":1,"family":"gemini","replies":[{"id":"a","match":{},"response":{"text":"x","finish":"stop","toolCalls":[{"name":"n","args":{"deep":{"__proto__":{"polluted":true}}}}]}}]}',
      '{"version":1,"family":"gemini","replies":[{"id":"__proto__","match":{},"response":{"text":"x","finish":"stop"}}]}',
    ];
    for (const text of texts) {
      const result = parseModelReplySetFileBytes(bytes(text));
      expect(result.ok, text).toBe(false);
      expect(polluted()).toBeUndefined();
    }
  });
  it("refuses every enum and shape violation", () => {
    const bad = [
      { ...fileSet(), version: 2 },
      fileSet([], "bedrock"),
      fileSet([], "nope"),
      fileSet([fileReply("A")]),
      fileSet([fileReply("")]),
      fileSet([fileReply("a".repeat(65))]),
      fileSet([fileReply("a"), fileReply("a")]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stopped" } })]),
      fileSet([fileReply("a", { response: { text: 5, finish: "stop" } })]),
      fileSet([fileReply("a", { response: { text: "x".repeat(1_000_001), finish: "stop" } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", usage: { inputTokens: -1, outputTokens: 1 } } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", usage: { inputTokens: 1.5, outputTokens: 1 } } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", usage: { inputTokens: 2_000_000_000, outputTokens: 1 } } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "tool_calls", toolCalls: Array.from({ length: 33 }, () => ({ name: "n", args: {} })) } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", toolCalls: [{ name: "", args: {} }] } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", toolCalls: [{ name: "n", args: [] }] } })]),
      fileSet([fileReply("a", { response: { text: "x", finish: "stop", toolCalls: [{ name: "n", args: { n: Number.POSITIVE_INFINITY } }] } })]),
      fileSet([fileReply("a", { match: { operation: "rm -rf" } })]),
      fileSet([fileReply("a", { match: { operation: "messages" } })]), // an Anthropic operation in a Gemini set
      fileSet([fileReply("a", { match: { sequence: 0 } })]),
      fileSet([fileReply("a", { match: { sequence: 1.5 } })]),
      fileSet([fileReply("a", { match: { sequence: 10_001 } })]),
      fileSet([fileReply("a", { match: { promptSha256: "A".repeat(64) } })]),
      fileSet([fileReply("a", { match: { promptSha256: "a".repeat(63) } })]),
      fileSet([fileReply("a", { match: { promptContains: "" } })]),
      fileSet([fileReply("a", { match: { promptContains: "x".repeat(513) } })]),
      fileSet([fileReply("a", { match: { promptContains: "x", promptSha256: "a".repeat(64) } })]),
      fileSet([fileReply("a", { match: { model: "" } })]),
      fileSet([fileReply("a", { match: { model: "m".repeat(129) } })]),
    ];
    for (const value of bad) expect(ModelReplySetFileSchema.safeParse(value).success, JSON.stringify(value).slice(0, 160)).toBe(false);
  });
  it("is bounded: 2,000 replies and 4 MiB", () => {
    expect(MODEL_REPLY_SET_MAX_REPLIES).toBe(2000);
    expect(MODEL_REPLY_SET_MAX_BYTES).toBe(4 * 1024 * 1024);
    const many = (count: number) => fileSet(Array.from({ length: count }, (_, index) => fileReply(`r${String(index)}`)));
    expect(ModelReplySetFileSchema.safeParse(many(2000)).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(many(2001)).success).toBe(false);
    const fat = fileSet(Array.from({ length: 5 }, (_, index) => fileReply(`r${String(index)}`, { response: { text: "x".repeat(900_000), finish: "stop" } })));
    expect(ModelReplySetFileSchema.safeParse(fat).success).toBe(false); // 4.5 MB of text
    const justUnder = fileSet(Array.from({ length: 4 }, (_, index) => fileReply(`r${String(index)}`, { response: { text: "x".repeat(900_000), finish: "stop" } })));
    expect(ModelReplySetFileSchema.safeParse(justUnder).success).toBe(true);
    expect(parseModelReplySetFileBytes(new Uint8Array(MODEL_REPLY_SET_MAX_BYTES + 1))).toEqual({ ok: false, reason: "the reply set is too large" });
  });
  it("the byte parser gives fixed reasons and never throws", () => {
    expect(parseModelReplySetFileBytes(bytes("not json"))).toEqual({ ok: false, reason: "the reply set is not valid JSON" });
    expect(parseModelReplySetFileBytes(new Uint8Array([0xff, 0xfe, 0x7b]))).toEqual({ ok: false, reason: "the reply set is not valid JSON" });
    expect(parseModelReplySetFileBytes(bytes({ nope: 1 }))).toEqual({ ok: false, reason: "the reply set does not pass the reply-set schema" });
    const ok = parseModelReplySetFileBytes(bytes(fileSet()));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("the resolved form (what the helper loads)", () => {
  it("needs a provenance on every reply, an origin exactly when it is before_task", () => {
    expect(ModelReplySetSchema.safeParse(stamped([fileReply("a")])).success).toBe(true);
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance: "independent", origin: undefined }])).success).toBe(true);
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance: "task_made", origin: undefined }])).success).toBe(true);
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), origin: undefined }])).success).toBe(false); // before_task without an origin
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance: "task_made" }])).success).toBe(false); // an origin on a task_made reply
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance: "independent" }])).success).toBe(false);
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance: undefined, origin: undefined }])).success).toBe(false);
    for (const provenance of ["failure_pack", "Before_Task", "real", "", "__proto__"]) expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), provenance }])).success, provenance).toBe(false);
    expect(ModelReplySetSchema.safeParse(stamped([{ ...fileReply("a"), origin: "somebody" }])).success).toBe(false);
    expect(parseModelReplySetBytes(bytes(stamped([fileReply("a")]))).ok).toBe(true);
    expect(parseModelReplySetBytes(bytes(fileSet())).ok).toBe(false);
  });
});

describe("stampReplyProvenance: the worker's decision is the only way a provenance gets in", () => {
  const file = ModelReplySetFileSchema.parse(fileSet([fileReply("a"), fileReply("b"), fileReply("c"), fileReply("d")]));
  const hashOf = (id: string) => modelReplyEntrySha256(file.replies.find((reply) => reply.id === id) as never);
  it("applies the worker's decisions (each bound to the reply's content hash)", () => {
    const set = stampReplyProvenance(
      file,
      new Map<string, ReplyProvenanceDecision | IndependentReplyDecision>([
        ["a", { provenance: "before_task" as const, origin: "customer_written" as const, contentSha256: hashOf("a") }],
        ["b", { provenance: "task_made" as const, contentSha256: hashOf("b") }],
        ["c", createRovaraIndependentDecision(hashOf("c"))],
      ]),
    );
    expect(set.replies.map((reply) => [reply.id, reply.provenance])).toEqual([["a", "before_task"], ["b", "task_made"], ["c", "independent"], ["d", "task_made"]]);
    expect(set.replies[0]).toMatchObject({ origin: "customer_written" });
    expect(ModelReplySetSchema.safeParse(set).success).toBe(true);
  });
});

describe("digest and content hash", () => {
  it("the digest does not depend on key order and changes with any reply", () => {
    const a = ModelReplySetFileSchema.parse(fileSet([fileReply("a"), fileReply("b")]));
    const reordered = ModelReplySetFileSchema.parse({ replies: [{ response: { finish: "stop", text: "answer a" }, match: {}, id: "a" }, { match: {}, id: "b", response: { text: "answer b", finish: "stop" } }], family: "gemini", version: 1 });
    expect(modelReplySetDigest(a)).toBe(modelReplySetDigest(reordered));
    expect(modelReplySetDigest(a)).toMatch(/^[0-9a-f]{64}$/u);
    const changed = ModelReplySetFileSchema.parse(fileSet([fileReply("a"), fileReply("b", { response: { text: "other", finish: "stop" } })]));
    expect(modelReplySetDigest(changed)).not.toBe(modelReplySetDigest(a));
    const order = ModelReplySetFileSchema.parse(fileSet([fileReply("b"), fileReply("a")]));
    expect(modelReplySetDigest(order)).not.toBe(modelReplySetDigest(a)); // first match wins: the order is content
  });
});

describe("selectModelReply: first match wins, sequence counts matching calls, no match is unmatched", () => {
  const set = (replies: unknown[]) => ModelReplySetSchema.parse(stamped(replies as Record<string, unknown>[]));
  const call = (over: Partial<{ model: string | undefined; operation: string; promptText: string | undefined }> = {}) => ({ model: "m1", operation: "generateContent", promptText: "what is the weather in Paris", ...over });
  it("model, operation, promptContains (literal, case-sensitive) and promptSha256 all narrow", () => {
    const s = set([fileReply("a", { match: { model: "m2" } }), fileReply("b", { match: { operation: "streamGenerateContent" } }), fileReply("c", { match: { promptContains: "paris" } }), fileReply("d", { match: { promptContains: ".*" } })]);
    expect(selectModelReply(s, call(), new Map()).reply).toBeUndefined();
    expect(selectModelReply(s, call({ model: "m2" }), new Map()).reply?.id).toBe("a");
    expect(selectModelReply(s, call({ operation: "streamGenerateContent" }), new Map()).reply?.id).toBe("b");
    expect(selectModelReply(s, call({ promptText: "x paris y" }), new Map()).reply?.id).toBe("c");
    expect(selectModelReply(s, call({ promptText: "a regex .* literal" }), new Map()).reply?.id).toBe("d"); // never a regex
    expect(selectModelReply(s, call({ promptText: "anything at all" }), new Map()).reply).toBeUndefined();
  });
  it("promptSha256 matches the SHA-256 of the prompt text", async () => {
    const { createHash } = await import("node:crypto");
    const prompt = "hash me";
    const s = set([fileReply("h", { match: { promptSha256: createHash("sha256").update(prompt).digest("hex") } })]);
    expect(selectModelReply(s, call({ promptText: prompt }), new Map()).reply?.id).toBe("h");
    expect(selectModelReply(s, call({ promptText: `${prompt}!` }), new Map()).reply).toBeUndefined();
    expect(selectModelReply(s, call({ promptText: undefined }), new Map()).reply).toBeUndefined();
  });
});
