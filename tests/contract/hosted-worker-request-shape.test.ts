import { readFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerModelRuntime } from "../../packages/worker/src/pi-session.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";

// The gateway mirrors this literal wire fixture. A client upgrade that drops a cache
// marker, changes its TTL, or introduces a media block must fail this contract.
const fixture = JSON.parse(readFileSync(new URL("../fixtures/hosted-worker-request-shape.json", import.meta.url), "utf8")) as Record<"short" | "long", Record<"initial" | "toolResult", unknown>>;
const modelId = "zai.glm-5";
const route = { alias: modelId, api: "anthropic-messages", catalog: modelId } as const;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function conversation(turn: "initial" | "toolResult"): Context {
  const context: Context = {
    systemPrompt: "Help with this repository.",
    tools: [
      { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
      { name: "list_files", description: "List files", parameters: Type.Object({ path: Type.String() }) },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect the repository." }, { type: "text", text: "Read README.md." }], timestamp: 1 }],
  };
  if (turn === "toolResult") context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "I will read the file." }, { type: "toolCall", id: "toolu_read_1", name: "read_file", arguments: { path: "README.md" } }], api: "anthropic-messages", provider: "rovara-route", model: modelId, usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "toolu_read_1", toolName: "read_file", content: [{ type: "text", text: "# Example repository" }], isError: false, timestamp: 3 },
  );
  return context;
}

function answer(): Response {
  const events = [
    { type: "message_start", message: { id: "msg_shape", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe.each(["short", "long"] as const)("hosted worker gateway wire contract: cacheRetention %s", (cacheRetention) => {
  it.each(["initial", "toolResult"] as const)("pins cache placement, TTL and text/tool blocks for the %s turn", async (turn) => {
    const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    // Replace only the HTTP boundary: task model resolution, worker runtime, Pi's
    // Anthropic serializer and runtime's outgoing fetch path are all production code.
    const transport: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(typeof init?.body).toBe("string");
      requests.push({ url, method: init?.method, body: JSON.parse(init?.body as string) as unknown });
      return answer();
    };
    vi.stubGlobal("fetch", transport);
    const access = await resolveTaskSessionModel({ modelRoute: route }, undefined, { PI_CACHE_RETENTION: cacheRetention }, undefined, { baseUrl: "https://gateway.example", apiKey: "fixture-task-key" });
    expect(access.model.cacheRetention).toBe(cacheRetention);
    const { runtime, model } = await workerModelRuntime(access.model, undefined, undefined, access.meteredProxy);
    const entry = runtime.getModel(model.provider, model.modelId)!;
    const result = await runtime.completeSimple(entry, conversation(turn), { cacheRetention: model.cacheRetention! });
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.example/v1/messages?beta=true");
    expect(requests[0]?.method).toBe("POST");
    // Compare the entire serialized body, without normalizing away unknown fields,
    // cache markers, nested tool results or media. The fixture is never regenerated here.
    expect(requests[0]?.body).toStrictEqual(fixture[cacheRetention][turn]);
  });
});
