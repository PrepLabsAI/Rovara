// TE-F2 part A: provenance decides what counts toward "proven with scripted AI replies" (DECISIONS 161, as amended by 192a). Fail closed: `before_task` counts; `task_made` counts only once the real model confirmed the same test;
// `independent` (parked by 192a), the failure pack, an unmatched call and any unknown or missing value never do.
import { describe, expect, it } from "vitest";
import {
  BEFORE_TASK_ORIGINS,
  REPLY_PROVENANCES,
  REPLY_PROVENANCE_LABELS,
  REPLY_RESULT_CLASSES,
  isReplyProvenance,
  replyCountsTowardProof,
  replyLabelOf,
} from "../../packages/contracts/src/model-reply-provenance.js";

describe("replyCountsTowardProof", () => {
  it("counts before_task; task_made only when the real model confirmed it; independent never (DEC 192a)", () => {
    expect([...REPLY_PROVENANCES]).toEqual(["before_task", "independent", "task_made"]);
    expect(replyCountsTowardProof("before_task")).toBe(true);
    expect(replyCountsTowardProof("independent")).toBe(false);
    // No real-model result: fail closed.
    expect(replyCountsTowardProof("task_made")).toBe(false);
    expect(replyCountsTowardProof("task_made", "confirmed")).toBe(true);
    for (const realModel of ["unconfirmed", "disagreed", "Confirmed", "passed", undefined, null, true]) expect(replyCountsTowardProof("task_made", realModel), String(realModel)).toBe(false);
  });
  it("the real-model result changes nothing for any other provenance", () => {
    for (const realModel of [undefined, "confirmed", "unconfirmed", "disagreed"]) {
      expect(replyCountsTowardProof("before_task", realModel)).toBe(true);
      expect(replyCountsTowardProof("independent", realModel)).toBe(false);
    }
  });
  it("never counts the failure pack, an unmatched call or a refused one", () => {
    for (const value of ["failure_pack", "unmatched", "not_served", "refused"]) expect(replyCountsTowardProof(value, "confirmed"), value).toBe(false);
    expect([...REPLY_RESULT_CLASSES]).toEqual(["before_task", "independent", "task_made", "failure_pack", "unmatched", "not_served"]);
    for (const klass of REPLY_RESULT_CLASSES) expect(replyCountsTowardProof(klass), klass).toBe(klass === "before_task");
    for (const klass of REPLY_RESULT_CLASSES) expect(replyCountsTowardProof(klass, "confirmed"), klass).toBe(klass === "before_task" || klass === "task_made");
  });
  it("an unknown, missing or oddly spelled origin never counts (fail closed)", () => {
    const odd: unknown[] = [undefined, null, "", "Before_Task", "before_task ", " independent", "before-task", "real", "recorded", 0, 1, true, {}, [], ["before_task"], { toString: () => "before_task" }, Symbol.for("x"), "__proto__", "constructor", "toString", "hasOwnProperty"];
    for (const value of odd) { expect(replyCountsTowardProof(value), String(typeof value)).toBe(false); expect(replyCountsTowardProof(value, "confirmed"), String(typeof value)).toBe(false); }
  });
  it("a prototype-borne or inherited value cannot raise a count", () => {
    const sneaky = Object.create({ before_task: true }) as Record<string, unknown>;
    expect(replyCountsTowardProof(sneaky)).toBe(false);
    expect(isReplyProvenance("before_task")).toBe(true);
    expect(isReplyProvenance("failure_pack")).toBe(false);
    expect(isReplyProvenance("constructor")).toBe(false);
  });
});

describe("fixed labels", () => {
  it("task_made uses DEC 192a words and independent retains DEC 161 words", () => {
    expect(REPLY_PROVENANCE_LABELS.task_made).toBe("scripted replies written in this task");
    expect(REPLY_PROVENANCE_LABELS.independent).toBe("scripted replies written independently in this task");
  });
  it("nothing scripted is ever called Real, and every class has a label", () => {
    for (const klass of REPLY_RESULT_CLASSES) {
      const label = REPLY_PROVENANCE_LABELS[klass];
      expect(label.length, klass).toBeGreaterThan(0);
      expect(label, klass).not.toMatch(/\breal\b/iu);
    }
    expect(REPLY_PROVENANCE_LABELS.failure_pack).toMatch(/never proof|not counted/iu);
  });
  it("replyLabelOf gives the task-made label to anything unknown", () => {
    expect(replyLabelOf("before_task")).toBe(REPLY_PROVENANCE_LABELS.before_task);
    for (const value of [undefined, "nope", 3, null, {}]) expect(replyLabelOf(value)).toBe(REPLY_PROVENANCE_LABELS.task_made);
  });
  it("the origins a before_task reply may carry are fixed", () => {
    expect([...BEFORE_TASK_ORIGINS]).toEqual(["customer_written", "setup_agent_from_fakes", "real_recording_capped", "prompt_and_expected_shape", "repo_file_at_base"]);
  });
});
