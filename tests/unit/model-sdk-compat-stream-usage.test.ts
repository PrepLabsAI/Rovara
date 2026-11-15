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
    const options = { model: "gpt-test", seed: "marker", created: 1, lineEnding: "lf" as const, includeUsage: true };
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

const chatStream = (streamOptions: unknown, failure?: FailureSpec): string[] => {
    const body: Record<string, unknown> = { model: "gpt-test", stream: true, messages: [{ role: "user", content: "compat-text" }], tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }] };
    if (streamOptions !== undefined) body.stream_options = streamOptions;
    const result = serveModelRequestWithReplies(builtinModelCatalog().rows, set, { method: "POST", path: "/p/openai/v1/chat/completions", headers: {}, query: "", body: JSON.stringify(body) }, { seed: "sdk-test", failure });
    return result.answer.body.split("\n\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
};
const usageChunks = (events: string[]): number => events.filter(event => event !== "[DONE]").filter(event => (JSON.parse(event) as { choices: unknown[] }).choices.length === 0).length;
it.each<FailureSpec | undefined>([undefined, { mode: "token_limit", variant: "output" }, { mode: "refusal", variant: "refusal" }, { mode: "refusal", variant: "filter" }, { mode: "bad_tool_json" }])("OpenAI stream without include_usage has no usage-only chunk and every chunk has a choice: %j", (failure) => {
    for (const streamOptions of [undefined, {}, { include_usage: false }, { include_usage: "true" }, { include_usage: 1 }, null, [true]]) {
        const events = chatStream(streamOptions, failure);
        expect(events.at(-1)).toBe("[DONE]");
        expect(usageChunks(events)).toBe(0);
        for (const event of events.filter(entry => entry !== "[DONE]")) expect((JSON.parse(event) as { choices: Array<{ delta: unknown }> }).choices[0]?.delta).toBeDefined();
    }
});
it.each<FailureSpec | undefined>([undefined, { mode: "token_limit", variant: "output" }, { mode: "refusal", variant: "refusal" }, { mode: "bad_tool_json" }])("OpenAI stream with include_usage true has exactly one usage-only chunk, right before DONE: %j", (failure) => {
    const events = chatStream({ include_usage: true }, failure);
    expect(usageChunks(events)).toBe(1);
    expect((JSON.parse(events.at(-2) ?? "null") as { choices: unknown[] }).choices).toEqual([]);
});
it("appendOpenAiStreamUsage adds the chunk only for a literal includeUsage true", async () => {
    const { appendOpenAiStreamUsage } = await import("../../packages/contracts/src/model-render.js");
    const { buildChatCompletionStream } = await import("../../packages/contracts/src/model-family-openai.js");
    const reply = { text: "hi", finish: "stop" as const, usage: { inputTokens: 1, outputTokens: 2 } };
    const options = { model: "gpt-test", seed: "flag", created: 1, lineEnding: "lf" as const };
    const plain = buildChatCompletionStream(reply, options, "lf");
    expect(appendOpenAiStreamUsage(plain, reply, options)).toBe(plain);
    expect(appendOpenAiStreamUsage(plain, reply, { ...options, includeUsage: false })).toBe(plain);
    expect(appendOpenAiStreamUsage(plain, reply, { ...options, includeUsage: "true" as unknown as boolean })).toBe(plain);
    expect(appendOpenAiStreamUsage(plain, reply, { ...options, includeUsage: true })).toContain('"choices":[],"usage"');
});
