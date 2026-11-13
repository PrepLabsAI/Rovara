import { expect, it } from "vitest";
import { serveModelRequestWithReplies, builtinModelCatalog, type FailureSpec } from "../../packages/contracts/src/index.js";
import { stampSet } from "../support/model-helper-world.js";
const set = stampSet("openai_compatible", [{ id: "text", response: { text: "answer", finish: "stop", usage: { inputTokens: 12, outputTokens: 8 } } }]);
it.each<[
    FailureSpec | undefined,
    number
]>([[undefined, 20], [{ mode: "token_limit", variant: "output" }, 48], [{ mode: "refusal", variant: "refusal" }, 20], [{ mode: "refusal", variant: "filter" }, 20], [{ mode: "bad_tool_json" }, 20]])("OpenAI stream supplies the requested usage before DONE: %j", (failure, total) => {
    const result = serveModelRequestWithReplies(builtinModelCatalog().rows, set, { method: "POST", path: "/p/openai/v1/chat/completions", headers: {}, query: "", body: JSON.stringify({ model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "compat-text" }], tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }] }) }, { seed: "sdk-test", failure });
    const events = result.answer.body.split("\n\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const usage = JSON.parse(events.at(-2) ?? "null") as {
        choices: unknown[];
        usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
    };
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({ prompt_tokens: 12, completion_tokens: total - 12, total_tokens: total });
});
it("usage insertion leaves marker-like reply text intact", async () => {
    const { appendOpenAiStreamUsage } = await import("../../packages/contracts/src/model-render.js");
    const { buildChatCompletionStream } = await import("../../packages/contracts/src/model-family-openai.js");
    const reply = { text: "data: [DONE]", finish: "stop" as const, usage: { inputTokens: 1, outputTokens: 2 } };
    const options = { model: "gpt-test", seed: "marker", created: 1, lineEnding: "lf" as const };
    const body = appendOpenAiStreamUsage(buildChatCompletionStream(reply, options, "lf"), reply, options);
    const values = body.split("\n\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)) as {
        choices: Array<{
            delta: {
                content?: string;
            };
        }>;
    });
    expect(values.some(value => value.choices[0]?.delta.content === "data: [DONE]")).toBe(true);
});
