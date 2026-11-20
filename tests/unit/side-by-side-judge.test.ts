// TE-F10: the judge is independent (DECISIONS 161 applied to judging): it sees the two output texts and nothing else, its answer is strict JSON with no free text kept, and A/B is mapped back to old/new by code.
import { describe, expect, it } from "vitest";
import { newPromptVerdict, parseSideBySideVerdicts } from "../../packages/contracts/src/index.js";

describe("what the judge may answer", () => {
  const expected = ["case-1", "case-2"];
  it.each([
    ["an unknown top-level key", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-2", verdict: "same" }], note: "free text" })],
    ["an unknown key on a verdict (free text is never kept)", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same", reason: "because" }, { caseId: "case-2", verdict: "same" }] })],
    ["a wrong case id", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-9", verdict: "same" }] })],
    ["a missing case", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }] })],
    ["an unknown verdict word", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-2", verdict: "BETTER" }] })],
    ["nothing", ""],
  ])("is 'judge not run' for %s, never a guessed verdict", (_name, text) => {
    expect(parseSideBySideVerdicts(text, expected)).toEqual({ ok: false });
  });
});

describe("mapping A/B back to old and new", () => {
  it("maps a_better and b_better to the right side in BOTH orders", () => {
    expect(newPromptVerdict("a_better", "old_first")).toBe("worse");
    expect(newPromptVerdict("b_better", "old_first")).toBe("better");
    expect(newPromptVerdict("a_better", "new_first")).toBe("better");
    expect(newPromptVerdict("b_better", "new_first")).toBe("worse");
    for (const order of ["old_first", "new_first"] as const) {
      expect(newPromptVerdict("same", order)).toBe("same");
      expect(newPromptVerdict("different_unclear", order)).toBe("unclear");
    }
  });
});
