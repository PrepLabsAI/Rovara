// TE-F2 part A: the reply-set schema (strict, bounded, `__proto__` safe), the author-side file form that carries NO provenance, the stamp the worker applies, the stable digest, and the first-match-wins selection with `sequence`.
import { describe, expect, it } from "vitest";
import {
  MODEL_REPLY_SET_MAX_BYTES,
  MODEL_REPLY_SET_MAX_REPLIES,
  ModelReplySetFileSchema,
  ModelReplySetSchema,
  createRovaraIndependentDecision,
  modelReplyContentSha256,
  modelReplyEntrySha256,
  modelReplySetDigest,
  parseModelReplySetFileBytes,
  parseModelReplySetBytes,
  selectModelReply,
  stampReplyProvenance,
  type ReplyProvenanceDecision,
  type IndependentReplyDecision,
} from "../../packages/contracts/src/model-reply-set.js";
import { REPLY_PROVENANCES } from "../../packages/contracts/src/model-reply-provenance.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const fileReply = (id: string, over: Record<string, unknown> = {}) => ({ id, match: {}, response: { text: `answer ${id}`, finish: "stop" }, ...over });
const fileSet = (replies: unknown[] = [fileReply("a")], family = "gemini") => ({ version: 1, family, replies });
const stamped = (replies: Record<string, unknown>[], family = "gemini") => ({ version: 1, family, replies: replies.map((reply) => ({ provenance: "before_task", origin: "customer_written", ...reply })) });

describe("the file form (what a repo file may hold)", () => {
  it("accepts a minimal set and every match field", () => {
    const parsed = ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { model: "gemini-2.5-flash", operation: "generateContent", promptContains: "weather", sequence: 2 } }), fileReply("b", { match: { promptSha256: "a".repeat(64) } })]));
    expect(parsed.success).toBe(true);
  });
  it("refuses a provenance or origin key: a file the agent could write never says where a reply came from", () => {
    for (const extra of [{ provenance: "before_task" }, { provenance: "independent" }, { origin: "customer_written" }, { provenance: "before_task", origin: "customer_written" }]) {
      expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", extra)])).success, JSON.stringify(extra)).toBe(false);
    }
  });
  it("refuses unknown keys at every level", () => {
    expect(ModelReplySetFileSchema.safeParse({ ...fileSet(), extra: 1 }).success).toBe(false);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { extra: 1 })])).success).toBe(false);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { extra: 1 } })])).success).toBe(false);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { response: { text: "x", finish: "stop", extra: 1 } })])).success).toBe(false);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { response: { text: "x", finish: "stop", usage: { inputTokens: 1, outputTokens: 1, extra: 1 } } })])).success).toBe(false);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { response: { text: "x", finish: "stop", toolCalls: [{ name: "n", args: {}, extra: 1 }] } })])).success).toBe(false);
  });
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
  it("operations are checked against the set's family", () => {
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { operation: "messages" } })], "anthropic_messages")).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { operation: "rerank" } })], "cohere")).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { operation: "responses" } })], "openai_compatible")).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { operation: "chat_completions" } })], "vertex")).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(fileSet([fileReply("a", { match: { operation: "generateContent" } })], "cohere")).success).toBe(false);
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
  it("checks a 1 MB set fast", () => {
    const started = performance.now();
    const result = parseModelReplySetFileBytes(bytes(fileSet([fileReply("a", { response: { text: "y".repeat(1_000_000 - 200), finish: "stop" } })])));
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
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
  it("a reply with no decision, an unknown value or a before_task with no origin is task_made (never counted)", () => {
    const decisions = new Map<string, unknown>([
      ["a", { provenance: "before_task", contentSha256: hashOf("a") }],
      ["b", { provenance: "REAL", origin: "customer_written", contentSha256: hashOf("b") }],
      ["c", { provenance: "before_task", origin: "trust_me", contentSha256: hashOf("c") }],
    ]);
    const set = stampReplyProvenance(file, decisions as never);
    expect(set.replies.map((reply) => reply.provenance)).toEqual(["task_made", "task_made", "task_made", "task_made"]);
    for (const reply of set.replies) expect(reply).not.toHaveProperty("origin");
    expect(ModelReplySetSchema.safeParse(set).success).toBe(true);
  });
  it("cannot be raised by the file: a provenance written into a file cannot get through the file schema to be stamped", () => {
    const sneaky = { ...fileSet([fileReply("a", { provenance: "before_task", origin: "customer_written" })]) };
    expect(parseModelReplySetFileBytes(bytes(sneaky)).ok).toBe(false);
    expect([...REPLY_PROVENANCES]).toContain("independent");
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
  it("the content hash covers the response only", () => {
    const one = ModelReplySetFileSchema.parse(fileSet([fileReply("a")])).replies[0];
    const two = ModelReplySetFileSchema.parse(fileSet([fileReply("zzz", { match: { model: "m" } })])).replies[0];
    expect(modelReplyContentSha256(one!)).toMatch(/^[0-9a-f]{64}$/u);
    expect(modelReplyContentSha256(one!)).not.toBe(modelReplyContentSha256(two!)); // the text differs ("answer a" vs "answer zzz")
    const same = ModelReplySetFileSchema.parse(fileSet([fileReply("q", { response: { text: "answer a", finish: "stop" } })])).replies[0];
    expect(modelReplyContentSha256(same!)).toBe(modelReplyContentSha256(one!));
  });
});

describe("selectModelReply: first match wins, sequence counts matching calls, no match is unmatched", () => {
  const set = (replies: unknown[]) => ModelReplySetSchema.parse(stamped(replies as Record<string, unknown>[]));
  const call = (over: Partial<{ model: string | undefined; operation: string; promptText: string | undefined }> = {}) => ({ model: "m1", operation: "generateContent", promptText: "what is the weather in Paris", ...over });
  it("the first reply whose criteria all hold wins", () => {
    const s = set([fileReply("specific", { match: { promptContains: "Paris" } }), fileReply("general", { match: {} })]);
    expect(selectModelReply(s, call(), new Map()).reply?.id).toBe("specific");
    expect(selectModelReply(s, call({ promptText: "other" }), new Map()).reply?.id).toBe("general");
    const reversed = set([fileReply("general", { match: {} }), fileReply("specific", { match: { promptContains: "Paris" } })]);
    expect(selectModelReply(reversed, call(), new Map()).reply?.id).toBe("general");
  });
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
  it("a criterion on the prompt never matches a call whose prompt could not be read", () => {
    const s = set([fileReply("p", { match: { promptContains: "x" } }), fileReply("m", { match: { model: "m1" } })]);
    expect(selectModelReply(s, call({ promptText: undefined }), new Map()).reply?.id).toBe("m");
    expect(selectModelReply(s, call({ promptText: undefined, model: undefined }), new Map()).reply).toBeUndefined();
  });
  it("sequence is the nth call that matches that reply's other criteria", () => {
    const s = set([fileReply("first", { match: { promptContains: "x", sequence: 1 } }), fileReply("second", { match: { promptContains: "x", sequence: 2 } }), fileReply("always", { match: { promptContains: "x" , operation: "countTokens"} })]);
    let counts = new Map<string, number>();
    const seen: (string | undefined)[] = [];
    for (let index = 0; index < 4; index += 1) {
      const picked = selectModelReply(s, call({ promptText: "x" }), counts);
      seen.push(picked.reply?.id);
      counts = new Map(picked.nextCounts);
    }
    expect(seen).toEqual(["first", "second", undefined, undefined]);
  });
  it("does not change the counts it was given", () => {
    const s = set([fileReply("one", { match: { sequence: 1 } })]);
    const counts = new Map<string, number>();
    const picked = selectModelReply(s, call(), counts);
    expect(counts.size).toBe(0);
    expect(picked.nextCounts.get("one")).toBe(1);
  });
  it("a set for another family matches nothing", () => {
    const s = set([fileReply("a")]);
    expect(selectModelReply(s, call(), new Map(), "anthropic_messages").reply).toBeUndefined();
    expect(selectModelReply(s, call(), new Map(), "gemini").reply?.id).toBe("a");
  });
  it("an empty set and an undefined set are unmatched", () => {
    expect(selectModelReply(set([]), call(), new Map()).reply).toBeUndefined();
    expect(selectModelReply(undefined, call(), new Map()).reply).toBeUndefined();
  });
});
