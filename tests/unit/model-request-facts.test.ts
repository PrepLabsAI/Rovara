import { describe, expect, it } from "vitest";
import { PROMPT_TEXT_MAX_CHARS, readModelRequestFacts } from "../../packages/contracts/src/model-request-facts.js";
import { expectLinearScaling } from "../support/scaling.js";

const facts = (body: unknown) => readModelRequestFacts(typeof body === "string" ? body : JSON.stringify(body));

describe("readModelRequestFacts", () => {
  it("a body that is not a JSON object gives the empty facts", () => {
    for (const body of ["", "nope", "[1]", "null", "3", '"s"', "{"]) expect(facts(body), body).toMatchObject({ model: undefined, stream: false, promptText: undefined, inputCount: 1, documentCount: 0 });
  });
  it("the first declared tool: OpenAI, Anthropic, Gemini and Cohere shapes; unsafe names are ignored", () => {
    expect(facts({ tools: [{ type: "function", function: { name: "lookup" } }] }).toolName).toBe("lookup");
    expect(facts({ tools: [{ name: "get_weather", input_schema: {} }] }).toolName).toBe("get_weather");
    expect(facts({ tools: [{ functionDeclarations: [{ name: "gem_tool" }] }] }).toolName).toBe("gem_tool");
    expect(facts({ tools: [{ name: "bad name!" }] }).toolName).toBeUndefined();
    expect(facts({ tools: [] }).toolName).toBeUndefined();
    expect(facts({ tools: ["x"] }).toolName).toBeUndefined();
  });
  it("counts inputs: a string is one, a list of strings is one each, a list of token ids is one", () => {
    expect(facts({ input: "a" }).inputCount).toBe(1);
    expect(facts({ input: ["a", "b", "c"] }).inputCount).toBe(3);
    expect(facts({ input: [1, 2, 3] }).inputCount).toBe(1);
    expect(facts({ input: [[1, 2], [3]] }).inputCount).toBe(2);
    expect(facts({ texts: ["a", "b"] }).inputCount).toBe(2);
    expect(facts({ requests: [{}, {}, {}] }).inputCount).toBe(3);
    expect(facts({ instances: [{}, {}] }).inputCount).toBe(2);
    expect(facts({ input: [] }).inputCount).toBe(1);
  });
  it("is bounded in depth and size, and fast on 1 MB", () => {
    let deep: unknown = "buried";
    for (let index = 0; index < 40; index += 1) deep = { content: deep };
    expect(facts({ messages: [deep] }).promptText).toBe(""); // past depth 16 nothing is collected
    // 32,000 characters, then 256,000 (the 8N input stays at or under 256 KiB so it stays in CPU cache): linear work grows about 8x. The 900,000-character prompt runs once, un-timed, below.
    const textOf = (size: number) => JSON.stringify({ messages: [{ role: "user", content: "x".repeat(size) }] });
    expectLinearScaling((size) => {
      const text = textOf(size);
      return () => facts(text);
    }, { n: 32_000, label: "reading the facts of a large prompt" });
    const huge = facts(textOf(900_000));
    expect(huge.promptText?.length).toBe(900_000);
    const many = facts({ messages: Array.from({ length: 150_000 }, () => ({ content: "a" })) });
    expect((many.promptText?.length ?? 0)).toBeLessThanOrEqual(PROMPT_TEXT_MAX_CHARS);
  });
});
