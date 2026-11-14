// TE-R1 part A: the reply-store shapes (strict, bounded, `__proto__` safe) and the key layout TE-G7 extends.
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_STORE_LIMITS,
  IMPLICIT_COMPANY_ID,
  MODEL_REPLY_SET_MAX_BYTES,
  ModelReplySetFileSchema,
  REPLY_ADDED_BY_SOURCES,
  REPLY_ENTRY_BODY_MAX_BYTES,
  REPLY_SET_HEAD_MAX_ENTRIES,
  REPLY_STORE_OWN_PREFIXES,
  REPLY_STORE_WORDS,
  ReplyJoinMarkerSchema,
  ReplyOverlaySchema,
  ReplySetEntryBodySchema,
  ReplySetHeadSchema,
  ReplyStoreReplyIdSchema,
  companyOfKey,
  replyBranchKey,
  replyEntrySortKey,
  replyHeadSortKey,
  replyJoinSortKey,
  replyStorePartition,
  replyTaskSortKey,
} from "../../packages/contracts/src/index.js";

const sha = (char: string): string => char.repeat(64);
const headEntry = (index: number, over: Record<string, unknown> = {}) => ({ id: `r${index}`, entrySha256: index.toString(16).padStart(64, "0"), provenance: "task_made", ...over });
const head = (over: Record<string, unknown> = {}) => ({ kind: "model_replies", schemaVersion: 1, family: "gemini", branch: "main", revision: 1, entries: [headEntry(1)], digest: sha("a"), ...over });
const overlay = (over: Record<string, unknown> = {}) => ({ kind: "model_reply_overlay", schemaVersion: 1, family: "gemini", taskId: "task-1", revision: 1, entries: [{ id: "a", entrySha256: sha("b"), provenance: "task_made" }], ...over });

describe("the head", () => {
  it("accepts a head with each provenance, an origin only on before_task, and addedBy", () => {
    const entries = [
      headEntry(1, { provenance: "before_task", origin: "customer_written", addedBy: { source: "repo_import", commit: "c".repeat(40) } }),
      headEntry(2, { provenance: "independent", addedBy: { source: "independent_channel", taskId: "t-1" } }),
      headEntry(3),
    ];
    expect(ReplySetHeadSchema.safeParse(head({ entries })).success).toBe(true);
  });
  it("refuses an origin on a non-before_task entry and a before_task entry with no origin", () => {
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { origin: "customer_written" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { provenance: "before_task" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { provenance: "independent", origin: "customer_written" })] })).success).toBe(false);
  });
  it("refuses unknown keys at every level and a __proto__ key (own, as JSON.parse makes it)", () => {
    expect(ReplySetHeadSchema.safeParse(head({ extra: 1 })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { extra: 1 })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { addedBy: { source: "task_join", extra: 1 } })] })).success).toBe(false);
    for (const text of [`{"kind":"model_replies","schemaVersion":1,"family":"gemini","branch":"b","revision":1,"entries":[],"digest":"${sha("a")}","__proto__":{"x":1}}`]) {
      expect(ReplySetHeadSchema.safeParse(JSON.parse(text) as unknown).success).toBe(false);
    }
    const nested = JSON.parse(`{"id":"a","entrySha256":"${sha("b")}","provenance":"task_made","__proto__":{"provenance":"before_task"}}`) as unknown;
    expect(ReplySetHeadSchema.safeParse(head({ entries: [nested] })).success).toBe(false);
    expect(({} as Record<string, unknown>).provenance).toBeUndefined();
  });
  it("refuses every wrong enum, version, kind, family and hash", () => {
    for (const bad of [{ kind: "other" }, { schemaVersion: 2 }, { family: "nope" }, { digest: "xyz" }, { digest: sha("A") }, { revision: -1 }, { revision: 1.5 }, { revision: Number.NaN }, { branch: "" }, { branch: "a\nb" }]) {
      expect(ReplySetHeadSchema.safeParse(head(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { provenance: "real" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { origin: "made_up", provenance: "before_task" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { addedBy: { source: "elsewhere" } })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { id: "UPPER" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1, { entrySha256: "short" })] })).success).toBe(false);
  });
  it("takes 1,000 entries and refuses 1,001, a repeated id and a repeated content hash", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => headEntry(index + 1));
    expect(ReplySetHeadSchema.safeParse(head({ entries: many(REPLY_SET_HEAD_MAX_ENTRIES) })).success).toBe(true);
    expect(ReplySetHeadSchema.safeParse(head({ entries: many(REPLY_SET_HEAD_MAX_ENTRIES + 1) })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1), headEntry(2, { id: "r1" })] })).success).toBe(false);
    expect(ReplySetHeadSchema.safeParse(head({ entries: [headEntry(1), headEntry(2, { entrySha256: headEntry(1).entrySha256 })] })).success).toBe(false);
  });
  it("stays under the document store's 400 KB even when every field is at its longest (measured)", () => {
    const entries = Array.from({ length: REPLY_SET_HEAD_MAX_ENTRIES }, (_, index) => ({
      id: `r${index}`.padEnd(64, "x").slice(0, 64),
      entrySha256: index.toString(16).padStart(64, "0"),
      provenance: "before_task",
      origin: "prompt_and_expected_shape",
      addedBy: { taskId: `t${index}`.padEnd(64, "k"), source: "recording_intake", commit: "e".repeat(40) },
    }));
    // unique ids of 64 characters
    entries.forEach((entry, index) => { entry.id = `${index.toString(36).padStart(6, "0")}${"x".repeat(58)}`; });
    const full = head({ entries });
    expect(ReplySetHeadSchema.safeParse(full).success).toBe(true);
    const size = new TextEncoder().encode(JSON.stringify(full)).length;
    expect(size).toBeLessThan(DOCUMENT_STORE_LIMITS.maxDocumentBytes);
    expect(size).toBeGreaterThan(300_000); // a positive control: this is the worst case, not an empty head
    expect(ReplySetHeadSchema.safeParse(head({ entries: [{ ...entries[0], addedBy: { ...entries[0]!.addedBy, taskId: "k".repeat(65) } }] })).success).toBe(false);
    expect(DOCUMENT_STORE_LIMITS.maxDocumentBytes).toBe(400 * 1024);
  });
  it("lists every added-by source the lane writes", () => {
    expect([...REPLY_ADDED_BY_SOURCES]).toEqual(["repo_import", "setup_agent", "task_join", "independent_channel", "recording_intake"]);
  });
});

describe("the overlay", () => {
  it("holds only task_made and independent entries: a before_task entry is refused", () => {
    expect(ReplyOverlaySchema.safeParse(overlay()).success).toBe(true);
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "independent" }] })).success).toBe(true);
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "before_task" }] })).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "before_task", origin: "customer_written" }] })).success).toBe(false);
  });
  it("refuses an origin, unknown keys, __proto__, a repeated content hash and over 1,000 entries; allows a repeated id", () => {
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "task_made", origin: "customer_written" }] })).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(overlay({ extra: 1 })).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(JSON.parse(`{"kind":"model_reply_overlay","schemaVersion":1,"family":"gemini","taskId":"t","revision":1,"entries":[],"__proto__":{"a":1}}`) as unknown).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "task_made" }, { id: "b", entrySha256: sha("b"), provenance: "task_made" }] })).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: [{ id: "a", entrySha256: sha("b"), provenance: "task_made" }, { id: "a", entrySha256: sha("c"), provenance: "independent" }] })).success).toBe(true);
    const many = Array.from({ length: 1001 }, (_, index) => ({ id: `r${index}`, entrySha256: index.toString(16).padStart(64, "0"), provenance: "task_made" }));
    expect(ReplyOverlaySchema.safeParse(overlay({ entries: many })).success).toBe(false);
    expect(ReplyOverlaySchema.safeParse(overlay({ taskId: "a#b" })).success).toBe(false);
  });
  it("has a join marker shape that is strict", () => {
    const marker = { kind: "model_reply_join", schemaVersion: 1, taskId: "t-1", family: "gemini", branch: "main", headRevision: 2, added: 1 };
    expect(ReplyJoinMarkerSchema.safeParse(marker).success).toBe(true);
    expect(ReplyJoinMarkerSchema.safeParse({ ...marker, extra: 1 }).success).toBe(false);
    expect(ReplyJoinMarkerSchema.safeParse({ ...marker, added: 1001 }).success).toBe(false);
  });
});

describe("the reply body", () => {
  const body = { id: "a", match: {}, response: { text: "hi", finish: "stop" } };
  it("is {id, match, response} and nothing else: a provenance or origin key is refused, so provenance cannot ride on a body", () => {
    expect(ReplySetEntryBodySchema.safeParse(body).success).toBe(true);
    expect(ReplySetEntryBodySchema.safeParse({ ...body, provenance: "before_task" }).success).toBe(false);
    expect(ReplySetEntryBodySchema.safeParse({ ...body, origin: "customer_written" }).success).toBe(false);
    expect(ReplySetEntryBodySchema.safeParse(JSON.parse(`{"id":"a","match":{},"response":{"text":"x","finish":"stop"},"__proto__":{"a":1}}`) as unknown).success).toBe(false);
  });
  it("is at most 256 KiB as compact JSON", () => {
    const edge = (chars: number) => ({ ...body, response: { text: "x".repeat(chars), finish: "stop" } });
    const overhead = new TextEncoder().encode(JSON.stringify(edge(0))).length;
    expect(ReplySetEntryBodySchema.safeParse(edge(REPLY_ENTRY_BODY_MAX_BYTES - overhead)).success).toBe(true);
    expect(ReplySetEntryBodySchema.safeParse(edge(REPLY_ENTRY_BODY_MAX_BYTES - overhead + 1)).success).toBe(false);
    expect(REPLY_ENTRY_BODY_MAX_BYTES).toBeLessThan(MODEL_REPLY_SET_MAX_BYTES);
  });
  it("spells a reply id exactly as F2-A's file form does (no second spelling can drift)", () => {
    const ids = ["a", "a1", "a_b", "a.b-c", "-a", ".a", "A", "a b", "a#b", "", "x".repeat(64), "x".repeat(65), "__proto__", "é", "a/b", "0"];
    for (const id of ids) {
      const file = ModelReplySetFileSchema.safeParse({ version: 1, family: "gemini", replies: [{ id, match: {}, response: { text: "x", finish: "stop" } }] }).success;
      expect(ReplyStoreReplyIdSchema.safeParse(id).success, `id ${JSON.stringify(id)}`).toBe(file);
    }
  });
  it("accepts the same bodies the file form does (a file reply is a body)", () => {
    const reply = { id: "a", match: { promptContains: "x", sequence: 2, operation: "generateContent" }, response: { text: "x", finish: "stop", toolCalls: [{ name: "t", args: { a: 1 } }], usage: { inputTokens: 1, outputTokens: 2 } } };
    expect(ModelReplySetFileSchema.safeParse({ version: 1, family: "gemini", replies: [reply] }).success).toBe(true);
    expect(ReplySetEntryBodySchema.safeParse(reply).success).toBe(true);
    const bad = { ...reply, match: { sequence: 0 } };
    expect(ReplySetEntryBodySchema.safeParse(bad).success).toBe(false);
  });
});

describe("the key layout (TE-G7 extends it; it does not replace it)", () => {
  it("builds ORG#<company>#MOCKSET#<project> and the five sort keys", () => {
    expect(replyStorePartition("org_aaaaaaaaaaaaaaaaaaaa", "proj")).toBe("ORG#org_aaaaaaaaaaaaaaaaaaaa#MOCKSET#proj");
    expect(companyOfKey(replyStorePartition(IMPLICIT_COMPANY_ID, "proj"))).toBe(IMPLICIT_COMPANY_ID);
    expect(replyHeadSortKey("main", "gemini")).toBe(`HEAD#model#${replyBranchKey("main")}#gemini`);
    expect(replyEntrySortKey(sha("a"))).toBe(`ENTRY#${sha("a")}`);
    expect(replyTaskSortKey("task-1", "gemini")).toBe("TASK#task-1#gemini");
    expect(replyJoinSortKey("task-1", "gemini")).toBe("JOIN#task-1#gemini");
    expect([...REPLY_STORE_OWN_PREFIXES]).toEqual(["HEAD#model#", "ENTRY#", "TASK#", "JOIN#", "MADE#"]);
  });
  it("never puts a branch name raw in a key: a branch with '#', '/', spaces and unicode is hashed", () => {
    for (const branch of ["feature/a#b", "has space", "ünï", "a".repeat(255), "HEAD#model#x"]) {
      const key = replyHeadSortKey(branch, "gemini");
      expect(key).toMatch(/^HEAD#model#[0-9a-f]{64}#gemini$/u);
      expect(Buffer.byteLength(key)).toBeLessThan(DOCUMENT_STORE_LIMITS.maxKeyBytes);
    }
    expect(replyHeadSortKey("a", "gemini")).not.toBe(replyHeadSortKey("b", "gemini"));
    expect(replyHeadSortKey("a", "gemini")).not.toBe(replyHeadSortKey("a", "cohere"));
  });
  it("refuses a company with '#' or white space, so a company id cannot reach into another partition", () => {
    expect(() => replyStorePartition("org_a#MOCKSET#x", "p")).toThrow();
    expect(() => replyStorePartition("org a", "p")).toThrow();
  });
  it("keeps the generic partition name and a prefix list that excludes TE-G7's HEAD#service#", () => {
    expect(replyStorePartition("org_aaaaaaaaaaaaaaaaaaaa", "p")).toContain("#MOCKSET#");
    expect(REPLY_STORE_OWN_PREFIXES.some((prefix) => "HEAD#service#x".startsWith(prefix))).toBe(false);
  });
});

describe("the fixed words", () => {
  it("are fixed text with no variable part", () => {
    expect(Object.keys(REPLY_STORE_WORDS).sort()).toEqual(["conflict", "erased", "id_clash", "made_full", "not_allowed", "not_found", "too_large", "too_many"]);
    for (const text of Object.values(REPLY_STORE_WORDS)) expect(text).toMatch(/^[a-z ,]+$/u);
  });
});
