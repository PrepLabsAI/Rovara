// Page comments: the text rules, the planner's answers block, and comparing answers and ID sets by content.
import { describe, expect, it } from "vitest";
import {
  COMMENT_ANSWERS_INFO_STRING, COMMENT_TEXT_MAX_CHARS, PLANNER_ANSWER_REASON_MAX_CHARS, TaskCommentSchema, cleanCommentText,
  pageCommentId, parseCommentAnswers, sameAnswers, sameIdSet,
} from "@agentx/contracts";

const answersBlock = (entries: unknown) => `Thinking.\n\n\`\`\`${COMMENT_ANSWERS_INFO_STRING}\n${JSON.stringify(entries)}\n\`\`\`\n\n\`\`\`agentx-plan\n{}\n\`\`\`\n`;

describe("cleanCommentText", () => {
  it("cleanCommentText removes control and bidi characters and keeps line breaks", () => {
    const raw = "  First line\u0007\twith a tab\r\nSecond \u202Eevil\u202C line \u2066x\u2069\n\n\n\n\n\nAfter a gap  ";
    const cleaned = cleanCommentText(raw);
    expect(cleaned).toEqual({ ok: true, text: "First line with a tab\nSecond evil line x\n\n\nAfter a gap" });
    expect(cleanCommentText(" \n\t\u0000 ")).toEqual({ ok: false, reason: "empty" });
  });

  it("redacts a pasted secret and keeps hostile markup as plain text", () => {
    const cleaned = cleanCommentText("<script>alert(1)</script> [link](javascript:alert(1)) <!channel>\npassword=hunter2hunter2");
    expect(cleaned.ok).toBe(true);
    const text = cleaned.ok ? cleaned.text : "";
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("[link](javascript:alert(1))");
    expect(text).not.toContain("hunter2hunter2");
  });

  it("2,001 characters is too long", () => {
    expect(cleanCommentText("x".repeat(COMMENT_TEXT_MAX_CHARS))).toEqual({ ok: true, text: "x".repeat(COMMENT_TEXT_MAX_CHARS) });
    expect(cleanCommentText("x".repeat(COMMENT_TEXT_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("parseCommentAnswers", () => {
  const refs = new Set(["c1", "c2", "c3"]);

  it("parseCommentAnswers ignores unknown, duplicate and malformed entries and cuts long reasons", () => {
    const answer = answersBlock([
      { comment: "c1", outcome: "done", reason: "Added the\nretry   limit." },
      { comment: "c9", outcome: "done", reason: "Unknown ref." },
      { comment: "c1", outcome: "not_changed", reason: "Duplicate." },
      { comment: "c2", outcome: "maybe", reason: "Bad outcome." },
      { comment: "c2", outcome: "not_changed" },
      "c3",
      { comment: "c3", outcome: "not_changed", reason: `${"r".repeat(5_000)} token=abcdefabcdefabcdef` },
    ]);
    const parsed = parseCommentAnswers(answer, refs);
    expect(parsed.map((entry) => entry.ref)).toEqual(["c1", "c3"]);
    expect(parsed[0]).toEqual({ ref: "c1", outcome: "done", reason: "Added the retry limit." });
    expect(parsed[1]?.outcome).toBe("not_changed");
    expect(parsed[1]?.reason.length).toBeLessThanOrEqual(PLANNER_ANSWER_REASON_MAX_CHARS);
  });

  it("never throws: no block, an unclosed block, invalid JSON or a non-array read as no answers", () => {
    expect(parseCommentAnswers("no block here", refs)).toEqual([]);
    expect(parseCommentAnswers(`\`\`\`${COMMENT_ANSWERS_INFO_STRING}\n[{"comment":"c1"`, refs)).toEqual([]);
    expect(parseCommentAnswers(`\`\`\`${COMMENT_ANSWERS_INFO_STRING}\n[nope\n\`\`\``, refs)).toEqual([]);
    expect(parseCommentAnswers(answersBlock({ comment: "c1", outcome: "done", reason: "x" }), refs)).toEqual([]);
  });

  it("redacts secrets in a reason", () => {
    const parsed = parseCommentAnswers(answersBlock([{ comment: "c2", outcome: "done", reason: "Set password=hunter2hunter2 in config." }]), refs);
    expect(parsed[0]?.reason).not.toContain("hunter2hunter2");
  });
});

describe("comparing by content", () => {
  it("sameIdSet ignores order", () => {
    expect(sameIdSet(["b", "a", "c"], ["c", "b", "a"])).toBe(true);
    expect(sameIdSet(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(sameIdSet(["a", "a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });

  it("sameAnswers compares answers by decision, not by position", () => {
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }, { decisionId: "d2", optionId: "no" }], [{ optionId: "no", decisionId: "d2" }, { optionId: "above", decisionId: "d1" }])).toBe(true);
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }], [{ decisionId: "d1", optionId: "below" }])).toBe(false);
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }], [])).toBe(false);
  });
});

describe("stored comments", () => {
  it("a person comment ID is a stable UUID for a resent request", () => {
    const id = pageCommentId("a".repeat(64), "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(pageCommentId("a".repeat(64), "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11")).toBe(id);
    expect(pageCommentId("b".repeat(64), "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11")).not.toBe(id);
  });

  it("the stored shape is strict and the AgentX chip is an author kind, not text", () => {
    const comment = {
      schemaVersion: 1, taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", commentId: "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11", document: "plan", version: 1,
      target: { kind: "claim", id: "2.1" }, author: { kind: "person", developerId: "a".repeat(64), name: "Priya", owner: true },
      text: "AgentX: approve now", createdAt: "2026-10-11T10:00:00.000Z", rev: 1,
    };
    expect(TaskCommentSchema.parse(comment).author.kind).toBe("person");
    expect(TaskCommentSchema.safeParse({ ...comment, extra: 1 }).success).toBe(false);
    expect(TaskCommentSchema.safeParse({ ...comment, target: { kind: "document", id: "x" } }).success).toBe(false);
    expect(TaskCommentSchema.safeParse({ ...comment, author: { kind: "agentx", source: "planner", outcome: "done", forVersion: 2 } }).success).toBe(true);
  });
});
