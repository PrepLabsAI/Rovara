import { describe, expect, it } from "vitest";
import { PROMPT_TEXT_MAX_CHARS, readModelRequestFacts } from "../../packages/contracts/src/model-request-facts.js";

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
  it("is bounded in depth and size", () => {
    let deep: unknown = "buried";
    for (let index = 0; index < 40; index += 1) deep = { content: deep };
    expect(facts({ messages: [deep] }).promptText).toBe(""); // past depth 16 nothing is collected
    // #1117: no wall-clock scaling check. It flaked on shared runners, and the bounds below (depth 16, the 1 MiB body, the 2 MiB prompt cap) are what limit the work.
    const textOf = (size: number) => JSON.stringify({ messages: [{ role: "user", content: "x".repeat(size) }] });
    const huge = facts(textOf(900_000));
    expect(huge.promptText?.length).toBe(900_000);
    const many = facts({ messages: Array.from({ length: 150_000 }, () => ({ content: "a" })) });
    expect((many.promptText?.length ?? 0)).toBeLessThanOrEqual(PROMPT_TEXT_MAX_CHARS);
  });
});
