// TE-F2 part A review fixes M1 and L3: provenance is decided from the BASE commit's file by content, never by reply id; the stamp refuses a decision whose content hash does not match; the order of the stamped set is the base
// order; `independent` can only come from the Rovara-side constructor and never from bytes.
import { describe, expect, it } from "vitest";
import {
  ModelReplySetFileSchema,
  ModelReplySetSchema,
  createRovaraIndependentDecision,
  decideFromBase,
  modelReplyEntrySha256,
  parseModelReplySetBytes,
  selectModelReply,
  stampReplyProvenance,
  type ModelReplyFileEntry,
} from "../../packages/contracts/src/model-reply-set.js";

const entry = (id: string, text: string, match: Record<string, unknown> = {}) => ({ id, match, response: { text, finish: "stop" } });
const file = (replies: unknown[], family = "openai_compatible") => ModelReplySetFileSchema.parse({ version: 1, family, replies });
const ids = (set: { replies: { id: string }[] }) => set.replies.map((reply) => reply.id);
const provs = (set: { replies: { id: string; provenance: string }[] }) => set.replies.map((reply) => `${reply.id}:${reply.provenance}`);
const stampFrom = (base: ReturnType<typeof file> | undefined, candidate: ReturnType<typeof file>) => {
  const decided = decideFromBase(base, candidate, "customer_written");
  return stampReplyProvenance(decided.file, decided.decisions);
};

describe("decideFromBase: a reply is before_task only if the base file has the same reply", () => {
  const base = file([entry("a", "Sunny", { promptContains: "Paris" }), entry("b", "Fallback")]);
  it("an identical file: every reply is before_task with the given origin, in the same order", () => {
    const set = stampFrom(base, base);
    expect(provs(set)).toEqual(["a:before_task", "b:before_task"]);
    expect(set.replies[0]).toMatchObject({ origin: "customer_written" });
    expect(ModelReplySetSchema.safeParse(set).success).toBe(true);
  });
  it("the reviewer's stamp-edited probe: an agent-edited reply with the same id is task_made", () => {
    const edited = file([entry("a", "whatever the code wants"), entry("b", "Fallback")]);
    const set = stampFrom(base, edited);
    expect(provs(set)).toEqual(["a:task_made", "b:before_task"]);
    expect(set.replies[0]?.response.text).toBe("whatever the code wants"); // the edit is served, never counted
    expect(set.replies[0]).not.toHaveProperty("origin");
  });
  it("an edited match (not only the text) is an edit", () => {
    expect(provs(stampFrom(base, file([entry("a", "Sunny", {}), entry("b", "Fallback")])))).toEqual(["a:task_made", "b:before_task"]);
    expect(provs(stampFrom(base, file([{ id: "a", match: { promptContains: "Paris" }, response: { text: "Sunny", finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } } }, entry("b", "Fallback")])))).toEqual(["a:task_made", "b:before_task"]);
  });
  it("a new reply is task_made and goes after the base replies", () => {
    expect(provs(stampFrom(base, file([entry("new", "Added"), entry("a", "Sunny", { promptContains: "Paris" }), entry("b", "Fallback")])))).toEqual(["a:before_task", "b:before_task", "new:task_made"]);
  });
  it("a renamed reply: the base reply is restored as before_task and the new id is task_made", () => {
    expect(provs(stampFrom(base, file([entry("a2", "Sunny", { promptContains: "Paris" }), entry("b", "Fallback")])))).toEqual(["a:before_task", "b:before_task", "a2:task_made"]);
  });
  it("a deleted base reply comes back as before_task: deleting cannot change which reply wins", () => {
    expect(provs(stampFrom(base, file([entry("b", "Fallback")])))).toEqual(["a:before_task", "b:before_task"]);
  });
  it("reordering the candidate cannot change which before_task reply wins", () => {
    const reordered = file([entry("b", "Fallback"), entry("a", "Sunny", { promptContains: "Paris" })]);
    const set = stampFrom(base, reordered);
    expect(ids(set)).toEqual(["a", "b"]);
    const call = { model: "m", operation: "chat_completions", promptText: "weather in Paris" };
    expect(selectModelReply(set, call, new Map()).reply?.id).toBe("a");
    // the same reorder, naively stamped in the candidate's order, would have served the fallback
    expect(ids(reordered as { replies: { id: string }[] })).toEqual(["b", "a"]);
  });
  it("an edited reply keeps the base position, so it cannot jump ahead of the base replies after it", () => {
    const three = file([entry("x", "1"), entry("y", "2"), entry("z", "3")]);
    const set = stampFrom(three, file([entry("z", "3"), entry("y", "EDITED"), entry("x", "1")]));
    expect(provs(set)).toEqual(["x:before_task", "y:task_made", "z:before_task"]);
  });
  it("no base file (the file is new): everything is task_made", () => {
    expect(provs(stampFrom(undefined, base))).toEqual(["a:task_made", "b:task_made"]);
  });
  it("a base of another family cannot vouch for the candidate: everything is task_made", () => {
    const other = file([entry("a", "Sunny", { promptContains: "Paris" })], "anthropic_messages");
    expect(provs(stampFrom(other, base))).toEqual(["a:task_made", "b:task_made"]);
  });
  it("the content hash covers id, match and response, with the id", () => {
    const a = base.replies[0] as ModelReplyFileEntry;
    expect(modelReplyEntrySha256(a)).toMatch(/^[0-9a-f]{64}$/u);
    expect(modelReplyEntrySha256(a)).toBe(modelReplyEntrySha256(ModelReplySetFileSchema.parse({ version: 1, family: "openai_compatible", replies: [{ response: { finish: "stop", text: "Sunny" }, match: { promptContains: "Paris" }, id: "a" }] }).replies[0] as ModelReplyFileEntry));
    expect(modelReplyEntrySha256(a)).not.toBe(modelReplyEntrySha256({ ...a, id: "other" }));
    expect(modelReplyEntrySha256(a)).not.toBe(modelReplyEntrySha256({ ...a, match: {} }));
  });
});

describe("stampReplyProvenance: a decision needs the reply's content hash", () => {
  const candidate = file([entry("a", "edited")]);
  const oldHash = modelReplyEntrySha256(entry("a", "original") as ModelReplyFileEntry);
  it("a before_task decision with another reply's hash falls to task_made", () => {
    const set = stampReplyProvenance(candidate, new Map([["a", { provenance: "before_task", origin: "customer_written", contentSha256: oldHash }]]));
    expect(provs(set)).toEqual(["a:task_made"]);
  });
  it("a decision with no hash, or a malformed one, is task_made", () => {
    for (const bad of [undefined, "", "zz", "A".repeat(64), 5, null]) {
      const decisions = new Map<string, unknown>([["a", { provenance: "before_task", origin: "customer_written", contentSha256: bad }]]);
      expect(provs(stampReplyProvenance(candidate, decisions as never)), String(bad)).toEqual(["a:task_made"]);
    }
  });
  it("a matching hash is what lets before_task through", () => {
    const hash = modelReplyEntrySha256(candidate.replies[0] as ModelReplyFileEntry);
    expect(provs(stampReplyProvenance(candidate, new Map([["a", { provenance: "before_task", origin: "customer_written", contentSha256: hash }]])))).toEqual(["a:before_task"]);
  });
  it("keeps the file's order and never reorders", () => {
    const two = file([entry("b", "B"), entry("a", "A")]);
    expect(ids(stampReplyProvenance(two, new Map()))).toEqual(["b", "a"]);
  });
});

describe("independent only comes from the Rovara-side constructor (L3)", () => {
  const candidate = file([entry("a", "Written independently")]);
  const hash = modelReplyEntrySha256(candidate.replies[0] as ModelReplyFileEntry);
  it("a plain object that says independent is task_made", () => {
    const set = stampReplyProvenance(candidate, new Map<string, unknown>([["a", { provenance: "independent", contentSha256: hash }]]) as never);
    expect(provs(set)).toEqual(["a:task_made"]);
  });
  it("a copy or a spread of a real independent decision is task_made too", () => {
    const real = createRovaraIndependentDecision(hash);
    expect(provs(stampReplyProvenance(candidate, new Map([["a", real]])))).toEqual(["a:independent"]);
    expect(provs(stampReplyProvenance(candidate, new Map<string, unknown>([["a", { ...real }]]) as never))).toEqual(["a:task_made"]);
  });
  it("an independent decision for other content is task_made", () => {
    const real = createRovaraIndependentDecision(modelReplyEntrySha256(entry("a", "something else") as ModelReplyFileEntry));
    expect(provs(stampReplyProvenance(candidate, new Map([["a", real]])))).toEqual(["a:task_made"]);
  });
  it("the constructor refuses a malformed hash", () => {
    expect(() => createRovaraIndependentDecision("nope")).toThrow(RangeError);
  });
  it("bytes that say independent are refused when parsed", () => {
    const text = JSON.stringify({ version: 1, family: "gemini", replies: [{ id: "a", match: {}, response: { text: "x", finish: "stop" }, provenance: "independent" }] });
    expect(parseModelReplySetBytes(new TextEncoder().encode(text))).toEqual({ ok: false, reason: "the reply set cannot carry an independent reply in a file" });
    const ok = JSON.stringify({ version: 1, family: "gemini", replies: [{ id: "a", match: {}, response: { text: "x", finish: "stop" }, provenance: "before_task", origin: "customer_written" }] });
    expect(parseModelReplySetBytes(new TextEncoder().encode(ok)).ok).toBe(true);
  });
});
