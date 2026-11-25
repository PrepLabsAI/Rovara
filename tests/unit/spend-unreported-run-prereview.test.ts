// SONNET PRE-REVIEW additions for SPEND-UNREPORTED-RUN (uncommitted, ONE file). Two gaps found in review:
//  (1) model-runtime's thrown-error catch path (the per-request key cannot be minted; tool history with no tools) sets the stable code but had no test.
//  (2) case (ii)(b), an event-log proof of "no model call", was unsound and is DELETED (money review): zero is booked only for a run that never reached a machine; its tests are in spend-unreported-run-settle.test.ts.
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { MODEL_CALL_FAILED_BEFORE_RESPONSE, createConfiguredModelRuntime, failedBeforeResponse } from "../../packages/model-runtime/src/index.js";

const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

describe("model-runtime's thrown-error catch path carries the stable code", () => {
  it("a request key that cannot be minted for this call (thrown inside the stream, nothing sent)", async () => {
    let mints = 0;
    let sent = 0;
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: (async () => { sent += 1; return new Response("never", { status: 200 }); }) as unknown as typeof fetch, onUsage: () => undefined,
      proxy: { baseUrl: "https://gateway.example", apiKey: async () => { mints += 1; if (mints > 1) throw new Error("mint failed"); return "one-task-token"; }, route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } },
    });
    const message = await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context, { maxRetries: 0, maxRetryDelayMs: 0 });
    expect(message.stopReason).toBe("error");
    expect(sent).toBe(0);
    expect(failedBeforeResponse(message)).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
  });

  it("tool history with no tools declared on a routed model is refused before anything is sent, and carries the code", async () => {
    let sent = 0;
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: (async () => { sent += 1; return new Response("never", { status: 200 }); }) as unknown as typeof fetch, onUsage: () => undefined,
      proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } },
    });
    const withToolResult = { messages: [{ role: "user", content: "hello", timestamp: 1 }, { role: "toolResult", toolCallId: "t1", toolName: "x", content: [{ type: "text", text: "r" }], isError: false, timestamp: 2 }] } as unknown as Context;
    const message = await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, withToolResult, { maxRetries: 0, maxRetryDelayMs: 0 });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("declares no tools");
    expect(sent).toBe(0);
    expect(failedBeforeResponse(message)).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
  });
});
