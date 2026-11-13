// TE-R2 part A: the leak screens. Each refusal, golden, in TS, Python and Go styles; a clean prompt passes; a changed input with no expectation passes; 1 MB-class input is fast. The screens are heuristics (what they miss is stated in the file).
import { describe, expect, it } from "vitest";
import { buildTaskLeakFacts, extractReplyBrief, screenBrief, NO_TASK_LEAK_FACTS, type ReplyBrief, type TaskLeakFacts } from "@agentx/contracts";

const briefFor = (prompt: string, extra: Record<string, unknown> = {}): ReplyBrief => {
  const result = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m", messages: [{ role: "user", content: prompt }], ...extra }));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.brief;
};
const tsTest = { path: "tests/unit/summarize.test.ts", changedLines: ['  it("summarizes the quarterly report briefly", async () => {', '    const out = await summarize("Revenue grew four percent in Q3.");', '    expect(out).toBe("Revenue up 4% in Q3");', "  });"] };
const pyTest = { path: "tests/test_summary.py", changedLines: ["def test_summary_is_short():", '    out = summarize("Revenue grew four percent in Q3.")', '    assert out == "Revenue up 4% in Q3"'] };
const goTest = { path: "pkg/summary/summary_test.go", changedLines: ["func TestSummaryIsShort(t *testing.T) {", '\tout := Summarize("Revenue grew four percent in Q3.")', '\tif out != "Revenue up 4% in Q3" {', "\t\tt.Fatalf(\"got %s\", out)"] };

describe("buildTaskLeakFacts", () => {
  it("reads test names, paths and assertion literals (and not the setup literal) in TS, Python and Go", () => {
    const facts = buildTaskLeakFacts([tsTest, pyTest, goTest]);
    expect(facts.testPaths).toEqual([tsTest.path, pyTest.path, goTest.path]);
    expect(facts.testNames).toEqual(expect.arrayContaining(["summarizes the quarterly report briefly", "test_summary_is_short", "TestSummaryIsShort"]));
    expect(facts.expectationLiterals).toContain("Revenue up 4% in Q3");
    expect(facts.expectationLiterals).not.toContain("Revenue grew four percent in Q3.");
  });
  it("is bounded and never throws on odd input", () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `expect(x).toBe("literal-number-${index}");`);
    const facts = buildTaskLeakFacts([{ path: "a.test.ts", changedLines: lines }, { path: "b.test.ts", changedLines: [undefined as unknown as string, "x".repeat(1_000_000)] }]);
    expect(facts.expectationLiterals.length).toBeLessThanOrEqual(2_000);
  });
});

describe("screenBrief", () => {
  const facts = buildTaskLeakFacts([tsTest, pyTest, goTest]);
  it("a clean prompt passes; so does a changed input with no expectation in it", () => {
    expect(screenBrief(briefFor("Write a friendly greeting for a new customer."), facts)).toEqual({ ok: true });
    expect(screenBrief(briefFor("Summarize: Revenue grew four percent in Q3."), facts)).toEqual({ ok: true });
    expect(screenBrief(briefFor("anything"), NO_TASK_LEAK_FACTS)).toEqual({ ok: true });
  });
  it("prompt_has_diff: each marker, also in a tool description", () => {
    for (const marker of ["diff --git a/x b/x", "@@ -1,3 +1,4 @@", "+++ b/src/app.ts"]) {
      expect(screenBrief(briefFor(`Review this:\n${marker}\nmore`), facts)).toEqual({ ok: false, reason: "prompt_has_diff" });
    }
    const tool = briefFor("hi there friend", { tools: [{ type: "function", function: { name: "t", description: "see diff --git a/x b/x", parameters: { type: "object" } } }] });
    expect(screenBrief(tool, NO_TASK_LEAK_FACTS)).toEqual({ ok: false, reason: "prompt_has_diff" });
  });
  it("prompt_echoes_test_expectation: the assertion literal in the prompt, TS, Python and Go, and with white space changed", () => {
    for (const file of [tsTest, pyTest, goTest]) {
      expect(screenBrief(briefFor('The answer must be "Revenue up 4% in Q3" exactly.'), buildTaskLeakFacts([file]))).toEqual({ ok: false, reason: "prompt_echoes_test_expectation" });
    }
    expect(screenBrief(briefFor("Answer:  Revenue   up\n4% in Q3"), facts)).toEqual({ ok: false, reason: "prompt_echoes_test_expectation" });
  });
  it("prompt_echoes_test_expectation: also from a tool description and a schema description", () => {
    const tool = briefFor("hello there", { tools: [{ type: "function", function: { name: "t", description: "Return Revenue up 4% in Q3", parameters: { type: "object" } } }] });
    expect(screenBrief(tool, facts)).toEqual({ ok: false, reason: "prompt_echoes_test_expectation" });
    const schema = briefFor("hello there", { response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { a: { type: "string", description: "Revenue up 4% in Q3" } } } } } });
    expect(screenBrief(schema, facts)).toEqual({ ok: false, reason: "prompt_echoes_test_expectation" });
  });
  it("a literal shorter than 6 characters is not an expectation (stated limit)", () => {
    const short = buildTaskLeakFacts([{ path: "a.test.ts", changedLines: ['expect(x).toBe("yes");', 'expect(y).toBe("hello");'] }]);
    expect(short.expectationLiterals).toEqual([]);
    expect(screenBrief(briefFor("say yes or hello"), short)).toEqual({ ok: true });
  });
  it("prompt_names_a_test: a changed test file's path or basename, or a test's name", () => {
    expect(screenBrief(briefFor("This is for tests/unit/summarize.test.ts please"), facts)).toEqual({ ok: false, reason: "prompt_names_a_test" });
    expect(screenBrief(briefFor("see summarize.test.ts"), facts)).toEqual({ ok: false, reason: "prompt_names_a_test" });
    expect(screenBrief(briefFor("run test_summary_is_short now"), facts)).toEqual({ ok: false, reason: "prompt_names_a_test" });
    expect(screenBrief(briefFor("TestSummaryIsShort wants it"), facts)).toEqual({ ok: false, reason: "prompt_names_a_test" });
    expect(screenBrief(briefFor("so summarizes the quarterly report briefly ok"), facts)).toEqual({ ok: false, reason: "prompt_names_a_test" });
  });
  it("checks fast on large inputs (64 KiB prompt, 2,000 literals)", () => {
    const literals = Array.from({ length: 2_000 }, (_, index) => `expect(v).toBe("expected-value-number-${index}");`);
    const big = buildTaskLeakFacts([{ path: "tests/big.test.ts", changedLines: literals }]);
    const prompt = "lorem ipsum dolor sit amet ".repeat(2_300);
    const started = Date.now();
    expect(screenBrief(briefFor(prompt), big)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it("checks a 1 MB prompt fast too (the screen is pure and takes any brief)", () => {
    const huge = { ...briefFor("seed prompt text here"), promptText: "lorem ipsum dolor sit amet ".repeat(40_000) } as ReplyBrief;
    const literals = buildTaskLeakFacts([{ path: "tests/big.test.ts", changedLines: Array.from({ length: 500 }, (_, index) => `expect(v).toBe("another-expected-value-${index}");`) }]);
    const started = Date.now();
    expect(screenBrief(huge, literals)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
