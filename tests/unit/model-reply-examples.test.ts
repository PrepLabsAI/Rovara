// TE-R2 part A: the real examples. before_task entries only (provenance read from the head entry), same operation, fits the shape, bounded, nearest model first. Nothing from a task's overlay can be one.
import { describe, expect, it } from "vitest";
import {
  REPLY_EXAMPLES_MAX,
  REPLY_EXAMPLES_TOTAL_MAX_BYTES,
  REPLY_EXAMPLE_MAX_BYTES,
  extractReplyBrief,
  modelReplyEntrySha256,
  pickExamples,
  type ModelReplyFileEntry,
  type ReplyBrief,
  type ReplySetHeadEntry,
} from "@agentx/contracts";

const brief = (): ReplyBrief => {
  const result = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Say something nice" }] }));
  if (!result.ok) throw new Error("no brief");
  return result.brief;
};
const reply = (id: string, text: string, match: ModelReplyFileEntry["match"] = {}): ModelReplyFileEntry => ({ id, match, response: { text, finish: "stop" } });
type Prov = ReplySetHeadEntry["provenance"];
function head(entries: readonly (readonly [Prov, ModelReplyFileEntry])[]): { entries: ReplySetHeadEntry[]; bodies: Map<string, unknown> } {
  const bodies = new Map<string, unknown>();
  const list = entries.map(([provenance, entry]): ReplySetHeadEntry => {
    const sha = modelReplyEntrySha256(entry);
    bodies.set(sha, { id: entry.id, match: entry.match, response: entry.response });
    return { id: entry.id, entrySha256: sha, provenance, ...(provenance === "before_task" ? { origin: "customer_written" as const } : {}) };
  });
  return { entries: list, bodies };
}

describe("pickExamples", () => {
  it("takes before_task entries only: never task_made, never independent (the head's provenance decides)", () => {
    const { entries, bodies } = head([
      ["task_made", reply("tm", "coding agent wrote this")],
      ["independent", reply("ind", "independent agent wrote this")],
      ["before_task", reply("bt", "customer wrote this")],
    ]);
    expect(pickExamples(entries, bodies, brief()).map((example) => example.id)).toEqual(["bt"]);
  });
  it("a before_task entry with no origin is not trusted; a body that no longer hashes to its key is skipped", () => {
    const { entries, bodies } = head([["before_task", reply("bt", "x1 customer")], ["before_task", reply("bt2", "x2 customer")]]);
    const noOrigin = entries.map((entry, index) => (index === 0 ? { id: entry.id, entrySha256: entry.entrySha256, provenance: "before_task" as const } : entry)) as ReplySetHeadEntry[];
    bodies.set(entries[1]!.entrySha256, { id: "bt2", match: {}, response: { text: "tampered", finish: "stop" } });
    expect(pickExamples(noOrigin, bodies, brief())).toEqual([]);
  });
  it("has no way to be handed an overlay: a task's replies are not in the head's entries, so they cannot appear", () => {
    expect(pickExamples.length).toBe(3);
    const { entries, bodies } = head([["before_task", reply("bt", "customer wrote this")]]);
    const overlayOnly = head([["independent", reply("o1", "this task's overlay reply")]]);
    for (const [sha, body] of overlayOnly.bodies) bodies.set(sha, body);
    const examples = pickExamples(entries, bodies, brief());
    expect(JSON.stringify(examples)).not.toContain("overlay reply");
  });
  it("same operation only (a reply naming another operation is skipped; one naming none is fine), and it must fit the shape", () => {
    const { entries, bodies } = head([
      ["before_task", reply("other-op", "embedding-ish", { operation: "responses" })],
      ["before_task", reply("same-op", "fine", { operation: "chat_completions" })],
      ["before_task", reply("no-op", "also fine")],
      ["before_task", { id: "fails-shape", match: {}, response: { text: "cut off", finish: "length" } }],
      ["before_task", { id: "empty", match: {}, response: { text: "", finish: "stop" } }],
    ]);
    expect(pickExamples(entries, bodies, brief()).map((example) => example.id)).toEqual(["same-op", "no-op"]); // head order inside the group
  });
  it("orders by the nearest model: the brief's own, then no model, then another model; head order inside a group; at most 3", () => {
    const { entries, bodies } = head([
      ["before_task", reply("far", "far", { model: "gpt-3.5" })],
      ["before_task", reply("none", "none text")],
      ["before_task", reply("near1", "near one", { model: "gpt-4o" })],
      ["before_task", reply("near2", "near two", { model: "gpt-4o" })],
      ["before_task", reply("near3", "near three", { model: "gpt-4o" })],
    ]);
    const ids = pickExamples(entries, bodies, brief()).map((example) => example.id);
    expect(ids).toEqual(["near1", "near2", "near3"]);
    expect(ids.length).toBeLessThanOrEqual(REPLY_EXAMPLES_MAX);
    const fewer = head([["before_task", reply("far", "far", { model: "gpt-3.5" })], ["before_task", reply("none", "none text")]]);
    expect(pickExamples(fewer.entries, fewer.bodies, brief()).map((example) => example.id)).toEqual(["none", "far"]);
  });
  it("bounds: each example at most 8 KiB and all at most 24 KiB; usage is dropped; identical replies appear once", () => {
    const big = (id: string, size: number) => reply(id, `${id} `.padEnd(size, "z"));
    const { entries, bodies } = head([["before_task", big("huge", REPLY_EXAMPLE_MAX_BYTES + 100)], ["before_task", big("a", 7_000)], ["before_task", big("b", 7_000)], ["before_task", big("c", 7_000)]]);
    const picked = pickExamples(entries, bodies, brief());
    expect(picked.map((example) => example.id)).toEqual(["a", "b", "c"]);
    expect(new TextEncoder().encode(JSON.stringify(picked)).length).toBeLessThanOrEqual(REPLY_EXAMPLES_TOTAL_MAX_BYTES);
    const withUsage = head([["before_task", { id: "u", match: {}, response: { text: "has usage", finish: "stop", usage: { inputTokens: 5, outputTokens: 6 } } }], ["before_task", reply("dup", "has usage")]]);
    const result = pickExamples(withUsage.entries, withUsage.bodies, brief());
    expect(result).toHaveLength(1);
    expect(result[0]?.response).toEqual({ text: "has usage", finish: "stop" });
  });
  it("shows a promptContains hint (masked) and none for a prompt-hash match; no examples is fine", () => {
    const { entries, bodies } = head([["before_task", reply("h", "hinted", { promptContains: "nice" })], ["before_task", reply("s", "hashed", { promptSha256: "a".repeat(64) })]]);
    const picked = pickExamples(entries, bodies, brief());
    expect(picked.find((example) => example.id === "h")?.promptContains).toBe("nice");
    expect(picked.find((example) => example.id === "s")).not.toHaveProperty("promptContains");
    expect(pickExamples([], new Map(), brief())).toEqual([]);
  });
});
