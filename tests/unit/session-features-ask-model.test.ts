// the Ask's own model call, for each request format the built-in providers speak. The request passes the proxy's guard unchanged (no field is added to it for Ask), carries no tool, and the
// key signs the call and appears nowhere in what comes back.
import { describe, expect, it } from "vitest";
import { SecretValue, type ModelKeyStore } from "@rovara-code/contracts";
import { createLocalAskModel } from "../../packages/core/src/local/ask-model.js";
import { builtinModelProviderBook } from "../../packages/core/src/local/model-proxy/proxy.js";

const KEY = ["sk", "test", "K".repeat(30)].join("-");
const keys: ModelKeyStore = { get: async () => new SecretValue(KEY), providers: async () => ["anthropic", "openai", "openrouter"] };
const signal = new AbortController().signal;

interface Seen { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function model(provider: string, api: "anthropic-messages" | "openai-completions" | "openai-responses" | undefined, reply: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const answerer = createLocalAskModel({
    choice: async () => ({ provider, model: "test-model", ...(api === undefined ? {} : { api }) }), keys, companyId: "org_x", providers: builtinModelProviderBook(), endpoints: { anthropic: "https://anthropic.test", openai: "https://openai.test", openrouter: "https://openrouter.test/api" },
    fetch: (async (url: string, init: RequestInit) => { const one = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Record<string, unknown> }; seen.push(one); return reply(one); }) as unknown as typeof fetch,
  });
  return { answerer, seen };
}
const ask = (answerer: ReturnType<typeof model>["answerer"]) => answerer.answer({ context: "RULES and task data", question: "What now?", maxOutputTokens: 1_200, signal, taskId: "t" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("the Ask's model call, per request format", () => {
  it("anthropic messages: rules as the system text, the question as the user's words, no tool", async () => {
    const { answerer, seen } = model("anthropic", undefined, () => json({ content: [{ type: "text", text: "Planning." }], usage: { input_tokens: 10, output_tokens: 3 } }));
    expect(await ask(answerer)).toMatchObject({ text: "Planning.", model: "anthropic/test-model", usage: { input: 10, output: 3, provider: "anthropic", modelId: "test-model" } });
    expect(seen[0]!.url).toBe("https://anthropic.test/v1/messages");
    expect(seen[0]!.body).toEqual({ model: "test-model", max_tokens: 1_200, system: "RULES and task data", messages: [{ role: "user", content: "What now?" }], stream: false });
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
  });

  it("openai chat: rules and question as two messages, nothing kept at the provider", async () => {
    const { answerer, seen } = model("openrouter", "openai-completions", () => json({ choices: [{ message: { content: "Planning." } }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
    expect(await ask(answerer)).toMatchObject({ text: "Planning.", usage: { input: 20, output: 4 } });
    expect(seen[0]!.body).toMatchObject({ model: "test-model", max_tokens: 1_200, stream: false, store: false, messages: [{ role: "system", content: "RULES and task data" }, { role: "user", content: "What now?" }] });
    expect(seen[0]!.body["tools"]).toBeUndefined();
  });

  it("openai responses (OpenAI's default format): passes the guard, with the rules as the first message of `input` and no `instructions` field", async () => {
    const { answerer, seen } = model("openai", undefined, () => json({ output: [{ type: "message", content: [{ type: "output_text", text: "Planning." }] }], usage: { input_tokens: 30, output_tokens: 5 } }));
    expect(await ask(answerer)).toMatchObject({ text: "Planning.", model: "openai/test-model", usage: { input: 30, output: 5 } });
    expect(seen[0]!.url).toBe("https://openai.test/v1/responses");
    expect(seen[0]!.body).toEqual({ model: "test-model", input: [{ role: "developer", content: "RULES and task data" }, { role: "user", content: "What now?" }], max_output_tokens: 1_200, stream: false, store: false });
    expect(seen[0]!.body["instructions"]).toBeUndefined();
  });

  it("fails with a fixed word and never the provider's words or the key: a refusal, a key echoed (also JSON-escaped), an answer past its size, no model", async () => {
    const refused = model("anthropic", undefined, () => json({ error: { message: `bad key ${KEY}` } }, 401));
    await expect(ask(refused.answerer)).rejects.toMatchObject({ reason: "provider_status_401", message: "provider_status_401" });
    const echoed = model("anthropic", undefined, () => json({ content: [{ type: "text", text: `the key is ${KEY}` }] }));
    await expect(ask(echoed.answerer)).rejects.toMatchObject({ reason: "key_in_answer" });
    // The same key with JSON escapes passes the raw-bytes check, and is caught in the parsed text.
    const escaped = model("anthropic", undefined, () => new Response(`{"content":[{"type":"text","text":"the key is ${[...KEY].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join("")}"}]}`, { status: 200 }));
    await expect(ask(escaped.answerer)).rejects.toMatchObject({ reason: "key_in_answer" });
    const big = model("anthropic", undefined, () => new Response("x".repeat(1_100_000), { status: 200 }));
    await expect(ask(big.answerer)).rejects.toMatchObject({ reason: "answer_too_large" });
    const none = createLocalAskModel({ choice: async () => undefined, keys, companyId: "org_x", providers: builtinModelProviderBook() });
    await expect(ask(none)).rejects.toMatchObject({ reason: "no_model" });
    expect(await none.available?.()).toBe(false);
  });
});
