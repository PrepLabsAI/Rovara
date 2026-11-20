// DEC 192a, away-log 168: ONE rule says whether a scripted reply counts toward proof. This pins that the reply-set rule, TE-A3's rule and the check rule agree for every (provenance x real-model result) pair, against a table
// written out by hand. (core-proof-table-and-body.test.ts runs the same pairs through the Proof table, which must match the same table.)
import { describe, expect, it } from "vitest";
import { checkCountsTowardProof, scriptedRepliesCountTowardProof } from "../../packages/contracts/src/index.js";
import { REPLY_RESULT_CLASSES, replyCountsTowardProof } from "../../packages/contracts/src/model-reply-provenance.js";

const REAL_MODEL = [undefined, "confirmed", "unconfirmed", "disagreed"] as const;
/** The rule, by hand. */
const COUNTS = (provenance: string, realModel: string | undefined): boolean => (provenance === "before_task" ? true : provenance === "task_made" ? realModel === "confirmed" : false);

describe("one rule for scripted replies and proof", () => {
  it.each([...REPLY_RESULT_CLASSES, "unknown_origin", "", "Before_Task"])("%s: every site gives the hand-written answer for every real-model result", (provenance) => {
    for (const realModel of REAL_MODEL) {
      const expected = COUNTS(provenance, realModel);
      const label = `${provenance} / ${String(realModel)}`;
      expect(replyCountsTowardProof(provenance, realModel), label).toBe(expected);
      expect(scriptedRepliesCountTowardProof(provenance, realModel), label).toBe(expected);
      expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: provenance, realModel }), label).toBe(expected);
    }
  });
});
