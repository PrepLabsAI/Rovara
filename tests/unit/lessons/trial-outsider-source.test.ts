// Approve by exception (decision 24) never starts a lesson on trial when any of its inputs came from an outsider, even when another input was a member's own correction: the outsider check stands on its
// own, not only through "not a member correction" (a lesson merged from a member's correction and an outsider's comment carries both marks).
import { describe, expect, it } from "vitest";
import { trialBlockers, type TrialContext } from "../../../packages/core/src/lessons/trial.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

const CLEAR: TrialContext = { preset: "standard", mode: "On", trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };
const clean = (over: Partial<Lesson["provenance"]> = {}): Lesson => lessonRecord({ tier: 1, tierReasons: [], status: "pending", approvals: [], provenance: { ...draft().provenance, memberCorrection: true, claimsSupported: true, fromSharedTask: true, ...over } });

describe("an outsider's input", () => {
  it("blocks the trial by itself, with its own reason; the same lesson from members only has no blocker", () => {
    expect(trialBlockers(clean(), 1, CLEAR)).toEqual([]);
    expect(trialBlockers(clean({ minTrust: "outsider" }), 1, CLEAR)).toEqual(["outsider_source"]);
  });
});
