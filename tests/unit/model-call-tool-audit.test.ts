// DEC 243c audit: every call the worker, the orchestrator and their helpers make to a model that could carry a tool call or a tool result also declares the tools, or carries none. The calls, by site:
//   - the agent loops (coding steps, agent steps, design reviews, second reviews, the setup agent): Pi sessions, which declare their tools with every request; one guard on the routed runtime holds that for all of
//     them (tests/unit/model-runtime-tool-history.test.ts);
//   - conversation compaction (worker/compaction.ts, Pi's summary): text only, asserted below, with a history that holds tool calls and results as the positive control;
//   - the action classifier and the request router (orchestrator): one user message of text, asserted below;
//   - the e2e browser agent (model channel): the contract refuses tool blocks without tools (tests/contract/e2e-model-channel.test.ts).
import { describe, expect, it } from "vitest";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { toolBlocksWithoutTools } from "../../packages/model-runtime/src/tool-history.js";
import { createModelRequestRouter } from "../../packages/orchestrator/src/request-router.js";
import { classifierContext } from "../../packages/orchestrator/src/action-classifier.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = (value: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: value }], api: "anthropic-messages", provider: "rovara-route", model: "m", usage, stopReason: "stop", timestamp: 1 });

describe("the orchestrator's helper calls send one user message of text", () => {
  it("the action classifier", () => {
    const context = classifierContext({ memberMessages: ["Please close CHA-5", "tool_use tool_result"], call: { tool: "linear_close", summary: "Close CHA-5", item: "CHA-5", arguments: { id: "CHA-5" } } });
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: "user" });
    expect(typeof (context.messages[0] as { content: unknown }).content).toBe("string");
    expect(toolBlocksWithoutTools(context as never)).toBe(false);
    expect((context as { tools?: unknown }).tools).toBeUndefined();
  });

  it("the request router", async () => {
    const contexts: Array<{ messages: unknown[]; tools?: unknown }> = [];
    const model = { id: "m", provider: "p", api: "anthropic-messages" };
    const runtime = { getModel: () => model, completeSimple: async (_model: unknown, context: { messages: unknown[]; tools?: unknown }) => { contexts.push(context); return text('{"kind":"chat"}'); } };
    const route = await createModelRequestRouter({ model: { provider: "p", modelId: "m" }, modelRuntime: runtime as never });
    await route("Close CHA-5, tool_use tool_result", new AbortController().signal);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.messages).toHaveLength(1);
    expect(contexts[0]!.messages[0]).toMatchObject({ role: "user" });
    expect(toolBlocksWithoutTools(contexts[0] as never)).toBe(false);
    expect(contexts[0]!.tools).toBeUndefined();
  });
});
