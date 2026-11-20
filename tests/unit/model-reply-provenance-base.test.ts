// TE-F2 part A review fixes M1 and L3: provenance is decided from the BASE commit's file by content, never by reply id; the stamp refuses a decision whose content hash does not match; the order of the stamped set is the base
// order; `independent` can only come from the Rovara-side constructor and never from bytes.
import { describe, expect, it } from "vitest";
import { ModelReplySetFileSchema, createRovaraIndependentDecision, decideFromBase, parseModelReplySetBytes, stampReplyProvenance } from "../../packages/contracts/src/model-reply-set.js";

const entry = (id: string, text: string, match: Record<string, unknown> = {}) => ({ id, match, response: { text, finish: "stop" } });
const file = (replies: unknown[], family = "openai_compatible") => ModelReplySetFileSchema.parse({ version: 1, family, replies });
const provs = (set: { replies: { id: string; provenance: string }[] }) => set.replies.map((reply) => `${reply.id}:${reply.provenance}`);
const stampFrom = (base: ReturnType<typeof file> | undefined, candidate: ReturnType<typeof file>) => {
  const decided = decideFromBase(base, candidate, "customer_written");
  return stampReplyProvenance(decided.file, decided.decisions);
};

describe("decideFromBase: a reply is before_task only if the base file has the same reply", () => {
  const base = file([entry("a", "Sunny", { promptContains: "Paris" }), entry("b", "Fallback")]);
  it("the reviewer's stamp-edited probe: an agent-edited reply with the same id is task_made", () => {
    const edited = file([entry("a", "whatever the code wants"), entry("b", "Fallback")]);
    const set = stampFrom(base, edited);
    expect(provs(set)).toEqual(["a:task_made", "b:before_task"]);
    expect(set.replies[0]?.response.text).toBe("whatever the code wants"); // the edit is served, never counted
    expect(set.replies[0]).not.toHaveProperty("origin");
  });
  it("a new reply is task_made and goes after the base replies", () => {
    expect(provs(stampFrom(base, file([entry("new", "Added"), entry("a", "Sunny", { promptContains: "Paris" }), entry("b", "Fallback")])))).toEqual(["a:before_task", "b:before_task", "new:task_made"]);
  });
  it("no base file (the file is new): everything is task_made", () => {
    expect(provs(stampFrom(undefined, base))).toEqual(["a:task_made", "b:task_made"]);
  });
});

describe("independent only comes from the Rovara-side constructor (L3)", () => {
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
