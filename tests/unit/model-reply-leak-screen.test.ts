// TE-R2 part A: the leak screens. Everything the agent is sent is screened (prompt, every schema string and key, tool names, enums, the model name) against every string literal of the changed tests and test data, normalized
// (NFKC, case, zero-width characters, white space, entities) and with base64, hex and URL-encoded runs decoded. The screens are heuristics (what they miss is stated in the file); they never PROVE independence.
import { describe, expect, it } from "vitest";
import { buildTaskLeakFacts, extractReplyBrief, screenBrief, NO_TASK_LEAK_FACTS, type ReplyBrief } from "@agentx/contracts";

const briefFor = (prompt: string, extra: Record<string, unknown> = {}, model = "m"): ReplyBrief => {
  const result = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model, messages: [{ role: "user", content: prompt }], ...extra }));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.brief;
};
const tsTest = { path: "tests/unit/summarize.test.ts", changedLines: ['  it("summarizes the quarterly report briefly", async () => {', '    const out = await summarize("Revenue grew four percent in Q3.");', '    expect(out).toBe("Revenue up 4% in Q3");', "  });"] };
const pyTest = { path: "tests/test_summary.py", changedLines: ["def test_summary_is_short():", '    out = summarize("Revenue grew four percent in Q3.")', '    assert out == "Revenue up 4% in Q3"'] };
const goTest = { path: "pkg/summary/summary_test.go", changedLines: ["func TestSummaryIsShort(t *testing.T) {", '\tout := Summarize("Revenue grew four percent in Q3.")', '\tif out != "Revenue up 4% in Q3" {', "\t\tt.Fatalf(\"got %s\", out)"] };
const EXPECT = "The refund was approved for order 4471";
const probeTest = {
  path: "tests/refund.test.ts",
  changedLines: [
    'it("approves the refund politely", async () => {',
    `  expect(reply).toBe("${EXPECT}");`,
    'const WANTED_LABEL = "positive-sentiment";',
    "  expect(label).toBe(WANTED_LABEL);",
    "  expect(obj).toEqual({",
    '    status: "escalated_to_human",',
    "  });",
  ],
};
const probe = buildTaskLeakFacts([probeTest]);
const refusedAs = (brief: ReplyBrief, facts = probe) => {
  const result = screenBrief(brief, facts);
  return result.ok ? "passes" : result.reason;
};
const schemaOf = (properties: Record<string, unknown>, top: Record<string, unknown> = {}) => ({ response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object", properties, ...top } } } });

describe("buildTaskLeakFacts", () => {
  it("reads test names, paths and EVERY string literal of 6 or more characters (not only assertion lines) in TS, Python and Go", () => {
    const facts = buildTaskLeakFacts([tsTest, pyTest, goTest]);
    expect(facts.testPaths).toEqual([tsTest.path, pyTest.path, goTest.path]);
    expect(facts.testNames).toEqual(expect.arrayContaining(["summarizes the quarterly report briefly", "test_summary_is_short", "TestSummaryIsShort"]));
    expect(facts.expectationLiterals).toEqual(expect.arrayContaining(["Revenue up 4% in Q3", "Revenue grew four percent in Q3."]));
    expect(facts.truncated).toBe(false);
  });
  it("takes a const defined on its own line and a multi-line object literal", () => {
    expect(probe.expectationLiterals).toEqual(expect.arrayContaining(["positive-sentiment", "escalated_to_human", EXPECT]));
  });
  it("splits a template literal around its substitutions", () => {
    const facts = buildTaskLeakFacts([{ path: "a.test.ts", changedLines: ["const x = `hello there ${name} and welcome back`;"] }]);
    expect(facts.expectationLiterals).toEqual(expect.arrayContaining(["hello there ", " and welcome back"]));
  });
  it("reads changed fixture and data files (json, yaml, txt, csv): quoted values, plain values, list items, cells", () => {
    const facts = buildTaskLeakFacts([
      { path: "tests/fixtures/expected.json", changedLines: ['  "answer": "Your parcel ships Tuesday",'] },
      { path: "tests/fixtures/expected.yaml", changedLines: ["answer: Your parcel ships Wednesday", "- plain list item here"] },
      { path: "tests/fixtures/expected.txt", changedLines: ["Your parcel ships Thursday"] },
      { path: "tests/fixtures/rows.csv", changedLines: ["id,Your parcel ships Friday,x"] },
    ]);
    expect(facts.expectationLiterals).toEqual(expect.arrayContaining(["Your parcel ships Tuesday", "Your parcel ships Wednesday", "plain list item here", "Your parcel ships Thursday", "Your parcel ships Friday"]));
    expect(facts.testPaths).toContain("tests/fixtures/expected.json");
  });
  it("is bounded, never throws on odd input, and says when it was cut (so the screen fails closed)", () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `expect(x).toBe("literal-number-${index}");`);
    const facts = buildTaskLeakFacts([{ path: "a.test.ts", changedLines: lines }, { path: "b.test.ts", changedLines: [undefined as unknown as string, "x".repeat(1_000_000)] }]);
    expect(facts.expectationLiterals.length).toBeLessThanOrEqual(4_000);
    expect(facts.truncated).toBe(true);
    expect(refusedAs(briefFor("an innocent prompt about nothing"), facts)).toBe("leak_facts_incomplete");
  });
});

describe("screenBrief: the clean cases", () => {
  const facts = buildTaskLeakFacts([tsTest, pyTest, goTest]);
  it("a clean prompt passes, and so does no facts at all", () => {
    expect(refusedAs(briefFor("Write a friendly greeting for a new customer."), facts)).toBe("passes");
    expect(refusedAs(briefFor("anything"), NO_TASK_LEAK_FACTS)).toBe("passes");
  });
  it("a prompt that carries a test's own input literal IS refused now (every literal counts): the price of a conservative screen", () => {
    expect(refusedAs(briefFor("Summarize: Revenue grew four percent in Q3."), facts)).toBe("prompt_echoes_test_expectation");
  });
});

describe("screenBrief: diff markers", () => {
  it("each marker, in the prompt and in a tool description", () => {
    for (const marker of ["diff --git a/x b/x", "@@ -1,3 +1,4 @@", "+++ b/src/app.ts"]) expect(refusedAs(briefFor(`Review this:\n${marker}\nmore`), NO_TASK_LEAK_FACTS)).toBe("prompt_has_diff");
    const tool = briefFor("hi there friend", { tools: [{ type: "function", function: { name: "t", description: "see diff --git a/x b/x", parameters: { type: "object" } } }] });
    expect(refusedAs(tool, NO_TASK_LEAK_FACTS)).toBe("prompt_has_diff");
  });
  it("a diff header hidden in base64 or hex is caught too", () => {
    const header = "diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts";
    expect(refusedAs(briefFor(`Decode: ${Buffer.from(header).toString("base64")}`), NO_TASK_LEAK_FACTS)).toBe("prompt_has_diff");
    expect(refusedAs(briefFor(`Decode: ${Buffer.from(header).toString("hex")}`), NO_TASK_LEAK_FACTS)).toBe("prompt_has_diff");
  });
  it("bare hunk lines (a run of + and - lines, no header) are caught; a bullet list and a rule line are not", () => {
    expect(refusedAs(briefFor("Look at:\n-  const a = 1;\n+  const a = 2;\n+  const b = 3;\nthanks"), NO_TASK_LEAK_FACTS)).toBe("prompt_has_diff");
    expect(refusedAs(briefFor("Shopping:\n- apples\n- pears\n- plums\n---\nok"), NO_TASK_LEAK_FACTS)).toBe("passes");
  });
});

describe("screenBrief: everything the agent is sent is screened (M1)", () => {
  const cases: [string, ReplyBrief][] = [
    ["prompt literal", briefFor(`Say: ${EXPECT}`)],
    ["json schema enum", briefFor("Classify", schemaOf({ r: { type: "string", enum: [EXPECT] } }))],
    ["json schema const", briefFor("Classify", schemaOf({ r: { const: EXPECT } }))],
    ["json schema default", briefFor("Classify", schemaOf({ r: { type: "string", default: EXPECT } }))],
    ["json schema examples", briefFor("Classify", schemaOf({ r: { type: "string", examples: [EXPECT] } }))],
    ["json schema property key", briefFor("Classify", schemaOf({ [EXPECT.replace(/ /gu, "_")]: { type: "string" } }))],
    ["json schema $comment", briefFor("Classify", schemaOf({}, { $comment: EXPECT }))],
    ["tool parameter enum", briefFor("Do it", { tools: [{ type: "function", function: { name: "reply", parameters: { type: "object", properties: { t: { type: "string", enum: [EXPECT] } } } } }], tool_choice: "required" })],
    ["tool parameter description (surviving mutant)", briefFor("Do it", { tools: [{ type: "function", function: { name: "reply", parameters: { type: "object", properties: { t: { type: "string", description: EXPECT } } } } }] })],
    ["tool description", briefFor("Do it", { tools: [{ type: "function", function: { name: "reply", description: EXPECT, parameters: { type: "object" } } }] })],
    ["tool name", briefFor("Do it", { tools: [{ type: "function", function: { name: "The_refund_was_approved_for_order_4471", parameters: { type: "object" } } }] })],
    ["model name", briefFor("Answer", {}, "The-refund-was-approved-for-order-4471")],
  ];
  for (const [name, brief] of cases) {
    const facts = name === "tool name" || name === "model name" ? buildTaskLeakFacts([{ path: "tests/refund.test.ts", changedLines: ['expect(x).toBe("The_refund_was_approved_for_order_4471");', 'expect(y).toBe("The-refund-was-approved-for-order-4471");'] }]) : probe;
    it(`refuses: ${name}`, () => {
      expect(refusedAs(brief, facts)).toBe("prompt_echoes_test_expectation");
    });
  }
  it("refuses a Gemini responseSchema enum and a system instruction literal", () => {
    const result = extractReplyBrief("gemini", "generateContent", JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseSchema: { type: "OBJECT", properties: { a: { type: "STRING", enum: [EXPECT] } } } } }));
    expect(result.ok && refusedAs(result.brief)).toBe("prompt_echoes_test_expectation");
    const system = extractReplyBrief("gemini", "generateContent", JSON.stringify({ systemInstruction: { parts: [{ text: `Always answer: ${EXPECT}` }] }, contents: [{ parts: [{ text: "hi" }] }] }));
    expect(system.ok && refusedAs(system.brief)).toBe("prompt_echoes_test_expectation");
  });
  it("the wrapper's description (json_schema.description, which the agent is not sent) is not screened, and a clean schema passes", () => {
    const wrapper = { response_format: { type: "json_schema", json_schema: { name: "x", description: EXPECT, schema: { type: "object", properties: { r: { type: "string" } } } } } };
    expect(refusedAs(briefFor("Classify", wrapper))).toBe("passes");
  });
});

describe("screenBrief: the same text in another dress (M2)", () => {
  const b64 = Buffer.from(EXPECT).toString("base64");
  const hex = Buffer.from(EXPECT).toString("hex");
  const url = encodeURIComponent(EXPECT).replace(/\./gu, "%2E");
  const dresses: [string, string][] = [
    ["case change", `Say (sentence case): ${EXPECT.toUpperCase()}`],
    ["zero-width characters", `Say: ${EXPECT.replace("refund", "re​fund")}`],
    ["soft hyphen and BOM", `Say: ${EXPECT.replace("approved", "appro­vd﻿".replace("vd", "ved"))}`],
    ["extra white space and newlines", "Say: The   refund was\napproved for\torder 4471"],
    ["full-width characters (NFKC)", `Say: ${EXPECT.replace("refund", "ｒｅｆｕｎｄ")}`],
    ["html entity", "Say: The refund was approved for order&#32;4471"],
    ["base64", `Decode and reply with: ${b64}`],
    ["url-safe base64 without padding", `Decode: ${b64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`],
    ["hex", `Decode this hex and reply: ${hex}`],
    ["percent-encoded", `Reply with ${url}`],
  ];
  for (const [name, prompt] of dresses) {
    it(`refuses: ${name}`, () => {
      expect(refusedAs(briefFor(prompt))).toBe("prompt_echoes_test_expectation");
    });
  }
  it("a literal split across two messages is found (the prompt is the messages joined)", () => {
    const result = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "m", messages: [{ role: "system", content: "Always answer: The refund was approved" }, { role: "user", content: "for order 4471 <- append this" }] }));
    expect(result.ok && refusedAs(result.brief)).toBe("prompt_echoes_test_expectation");
  });
  it("test names and labels, in another case", () => {
    expect(refusedAs(briefFor("Approves the refund politely"))).toBe("prompt_names_a_test");
    expect(refusedAs(briefFor("Always reply with exactly: positive-sentiment"))).toBe("prompt_echoes_test_expectation");
    expect(refusedAs(briefFor("Set status to ESCALATED_TO_HUMAN"))).toBe("prompt_echoes_test_expectation");
  });
  it("what it still misses is documented, not hidden: rot13 and a paraphrase pass", () => {
    expect(refusedAs(briefFor("Erfcbaq: Gur ershaq jnf nccebirq sbe beqre 4471"))).toBe("passes");
    expect(refusedAs(briefFor("Tell them the money back was okayed for their purchase"))).toBe("passes");
  });
});

describe("screenBrief: paths and names", () => {
  const facts = buildTaskLeakFacts([tsTest, pyTest, goTest]);
  it("a changed test file's path or basename, or a test's name", () => {
    expect(refusedAs(briefFor("This is for tests/unit/summarize.test.ts please"), facts)).toBe("prompt_names_a_test");
    expect(refusedAs(briefFor("see summarize.test.ts"), facts)).toBe("prompt_names_a_test");
    expect(refusedAs(briefFor("run test_summary_is_short now"), facts)).toBe("prompt_names_a_test");
    expect(refusedAs(briefFor("TestSummaryIsShort wants it"), facts)).toBe("prompt_names_a_test");
    expect(refusedAs(briefFor("so summarizes the quarterly report briefly ok"), facts)).toBe("prompt_names_a_test");
  });
  it("a literal shorter than 6 characters is not screened (stated limit)", () => {
    const short = buildTaskLeakFacts([{ path: "a.test.ts", changedLines: ['expect(x).toBe("yes");', 'expect(y).toBe("hello");'] }]);
    expect(short.expectationLiterals).toEqual([]);
    expect(refusedAs(briefFor("say yes or hello"), short)).toBe("passes");
  });
});

describe("speed", () => {
  it("checks a 64 KiB prompt against 4,000 literals fast", () => {
    const literals = Array.from({ length: 3_900 }, (_, index) => `expect(v).toBe("expected-value-number-${index}");`);
    const big = buildTaskLeakFacts([{ path: "tests/big.test.ts", changedLines: literals }]);
    const started = Date.now();
    expect(refusedAs(briefFor("lorem ipsum dolor sit amet ".repeat(2_300)), big)).toBe("passes");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it("checks a 1 MB prompt (a hand-made brief) fast too, including decoding runs", () => {
    const huge = { ...briefFor("seed prompt text here"), promptText: `${"lorem ipsum dolor sit amet ".repeat(30_000)} ${"QUJDREVGR0hJSktMTU5PUA".repeat(500)}` } as ReplyBrief;
    const facts = buildTaskLeakFacts([{ path: "tests/big.test.ts", changedLines: Array.from({ length: 500 }, (_, index) => `expect(v).toBe("another-expected-value-${index}");`) }]);
    const started = Date.now();
    expect(refusedAs(huge, facts)).toBe("passes");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
