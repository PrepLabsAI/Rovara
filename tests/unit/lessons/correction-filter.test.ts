// Lessons outcomes: the cheap pre-filter in front of the judge. The cases are in lessons-outcomes.test.ts too, through the whole path; here are its edges.
import { describe, expect, it } from "vitest";
import { looksLikeCorrection } from "../../../packages/core/src/lessons/correction-filter.js";

describe("looksLikeCorrection", () => {
  it("is false for empty, very short, praise, nit, acknowledgement and bare-question text, in any case and with a path prefix", () => {
    for (const text of ["", "   ", "fix", "LGTM", "lgtm :+1:", "Looks great, thanks a lot for this", "NIT: spacing", "Nitpick - maybe a comment here", "Minor: typo in the name above", "Optional: could extract this", "Thanks!", "On src/a.ts: LGTM, ship it", "What does this do exactly?", "Could you explain the reason for this?"]) expect(looksLikeCorrection(text), text).toBe(false);
  });
  it("is true for a directive, a bug report and a question that asks for a change", () => {
    for (const text of ["Use the shared retry helper instead of copying it", "This is a bug: it drops the error on the second attempt", "Should we use withRetry here instead of the loop?", "Never call the client from the handler directly", "On src/b.ts: avoid this, it breaks the cache"]) expect(looksLikeCorrection(text), text).toBe(true);
  });
});
