// TE-F2 part A: provenance decides what counts toward "proven with scripted AI replies" (DECISIONS 161, as amended by 192a). Fail closed: `before_task` counts; `task_made` counts only once the real model confirmed the same test;
// `independent` (parked by 192a), the failure pack, an unmatched call and any unknown or missing value never do.
import { describe, expect, it } from "vitest";
import { REPLY_PROVENANCE_LABELS, isReplyProvenance, replyCountsTowardProof, replyLabelOf } from "../../packages/contracts/src/model-reply-provenance.js";

describe("replyCountsTowardProof", () => {
  it("a prototype-borne or inherited value cannot raise a count", () => {
    const sneaky = Object.create({ before_task: true }) as Record<string, unknown>;
    expect(replyCountsTowardProof(sneaky)).toBe(false);
    expect(isReplyProvenance("before_task")).toBe(true);
    expect(isReplyProvenance("failure_pack")).toBe(false);
    expect(isReplyProvenance("constructor")).toBe(false);
  });
});

describe("fixed labels", () => {
  it("replyLabelOf gives the task-made label to anything unknown", () => {
    expect(replyLabelOf("before_task")).toBe(REPLY_PROVENANCE_LABELS.before_task);
    for (const value of [undefined, "nope", 3, null, {}]) expect(replyLabelOf(value)).toBe(REPLY_PROVENANCE_LABELS.task_made);
  });
});
