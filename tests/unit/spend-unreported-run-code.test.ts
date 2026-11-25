// SPEND-UNREPORTED-RUN item 2 (root cause R2: behaviour decided by raw text). model-runtime marks a model call that failed BEFORE any response with ONE stable code (with the HTTP status when there was one), and the
// worker decides "refused, nothing used" BY THAT CODE: the run then sends its zero report and the broker books it, so the task's spend is known. The fixed sentences are kept only to read a message that has no code
// (an older runtime's), for the skew window.
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { MODEL_CALL_FAILED_BEFORE_RESPONSE, createConfiguredModelRuntime, failedBeforeResponse } from "../../packages/model-runtime/src/index.js";
import { createMissingUsageDetector, createUsageCheckpointer, type UsageStats } from "../../packages/worker/src/usage.js";
import { readUsagePayload } from "../../packages/broker/src/core-host/usage-booking.js";

const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const NO_STATUS_SENTENCE = "Model source request failed; check credentials, model availability, rate limits and provider status";
const nothing: UsageStats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
const model = { provider: "rovara-route", modelId: "gpt-5" };

/** One call through the real model runtime on the hosted gateway route, with a transport that answers as the test says. */
async function call(transport: () => Promise<Response>) {
  const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
    fetch: (async () => transport()) as unknown as typeof fetch, onUsage: () => undefined,
    proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } },
  });
  return await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context, { maxRetries: 0, maxRetryDelayMs: 0 });
}

/** The worker's own reading of a failed message: what its usage detector does with it. */
function workerReads(message: unknown) {
  const detector = createMissingUsageDetector();
  detector.observe({ type: "message_end", message });
  return detector.refusedCalls;
}

describe("model-runtime says a call failed before any response by a stable code", () => {
  it("a failure with NO HTTP status (network, DNS, TLS, reset): the code, no status", async () => {
    const message = await call(async () => { throw new TypeError("fetch failed"); });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(NO_STATUS_SENTENCE);
    expect(failedBeforeResponse(message)).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
  });

  it("a failure with an HTTP status: the same code, with the status", async () => {
    for (const status of [400, 401, 409, 429, 500, 503]) {
      const message = await call(async () => new Response("denied", { status }));
      expect(failedBeforeResponse(message), String(status)).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE, status });
    }
  });

  it("a failure to read the key before the request is built carries the code too", async () => {
    let reads = 0;
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: (async () => { throw new Error("never reached"); }) as unknown as typeof fetch, onUsage: () => undefined,
      environment: { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf" },
      readSecret: async () => { reads += 1; if (reads > 1) throw new Error("secret store down"); return `not-a-real-key-${"0".repeat(40)}`; },
    });
    const message = await runtime.completeSimple(runtime.getModel("anthropic", MODEL)!, context, { maxRetries: 0, maxRetryDelayMs: 0 });
    expect(message.stopReason).toBe("error");
    expect(failedBeforeResponse(message)).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
  });

  it("a call that was cancelled carries no code (it did not fail)", async () => {
    const abort = new AbortController();
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: (async () => { abort.abort(); throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch, onUsage: () => undefined,
      proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } },
    });
    const message = await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context, { signal: abort.signal, maxRetries: 0 });
    expect(message.stopReason).toBe("aborted");
    expect(failedBeforeResponse(message)).toBeUndefined();
  });

  it("an answer whose stream began and then broke carries no code (that call may have been billed)", async () => {
    const message = await call(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`));
        controller.error(new Error("connection reset"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(message.stopReason).toBe("error");
    expect(failedBeforeResponse(message)).toBeUndefined();
  });

  it("reads a stored message tolerantly: only the code counts, the status only when it is a whole HTTP status, anything else is no mark", () => {
    const mark = (failedBeforeResponse: unknown) => ({ role: "assistant", failedBeforeResponse });
    expect(failedBeforeResponse(mark({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE, status: 503 }))).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE, status: 503 });
    expect(failedBeforeResponse(mark({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE, status: 99 }))).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
    expect(failedBeforeResponse(mark({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE, status: "503" }))).toEqual({ code: MODEL_CALL_FAILED_BEFORE_RESPONSE });
    for (const other of [undefined, null, 7, "x", {}, { code: "something_else" }, { code: MODEL_CALL_FAILED_BEFORE_RESPONSE.toUpperCase() }]) expect(failedBeforeResponse(mark(other)), JSON.stringify(other)).toBeUndefined();
    for (const notAMessage of [undefined, null, 5, "text"]) expect(failedBeforeResponse(notAMessage)).toBeUndefined();
  });
});

describe("the worker decides refused-and-nothing-used BY THE CODE", () => {
  it("the message the real runtime wrote for a failure with no status is refused: the sentence no longer matters", async () => {
    const message = await call(async () => { throw new TypeError("fetch failed"); });
    expect(workerReads(message)).toBe(1);
    // The decider is the code: the same message with another sentence is still refused, and with no code at all (and a sentence the legacy reader does not know) it is not.
    expect(workerReads({ ...message, errorMessage: "some words nobody listed" })).toBe(1);
    const uncoded: Record<string, unknown> = { ...message };
    delete uncoded["failedBeforeResponse"];
    expect(workerReads({ ...uncoded, errorMessage: "some words nobody listed" })).toBe(0);
  });

  it("with an HTTP status too, and for every status class (a status the legacy reader never knew, 409, is refused by the code)", async () => {
    for (const status of [401, 409, 418, 500, 529]) expect(workerReads(await call(async () => new Response("x", { status }))), String(status)).toBe(1);
  });

  it("a coded message whose response stream began is not refused (the detector's own stream evidence still holds)", () => {
    const detector = createMissingUsageDetector();
    const coded = { role: "assistant", stopReason: "error", content: [], errorMessage: "anything", failedBeforeResponse: { code: MODEL_CALL_FAILED_BEFORE_RESPONSE } };
    detector.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
    expect(detector.observe({ type: "message_end", message: coded })).toBe(true);
    expect(detector.refusedCalls).toBe(0);
  });

  it("an OLD runtime's message (no code) is still read by the fixed sentences during the skew window, except that nothing new is added to the list: its no-status sentence is decided by no words (the broker's settle covers such a run)", () => {
    const old = (errorMessage: string) => ({ role: "assistant", stopReason: "error", content: [], errorMessage });
    for (const sentence of ["Model source request failed; upstream unavailable; check provider status before retrying", "OpenRouter request failed; rate limited; wait before retrying"]) expect(workerReads(old(sentence)), sentence).toBe(1);
    expect(workerReads(old("Model source request failed; an answer this reader has never seen"))).toBe(0);
    expect(workerReads(old(NO_STATUS_SENTENCE))).toBe(0);
  });

  it("end to end: every call of a run failing with no status gives the zero report, and the broker books it at $0", async () => {
    const failed = await call(async () => { throw new TypeError("fetch failed"); });
    const sent: Record<string, unknown>[] = [];
    const tracker = createUsageCheckpointer({ enabled: true, baseline: undefined, stats: () => nothing, model: () => model, requested: {}, send: (payload) => sent.push(payload) });
    tracker.observe({ type: "message_end", message: failed }); tracker.observe({ type: "message_end", message: failed });
    const report = tracker.endReport(nothing, model, "FAILED", {})!;
    expect(report).toMatchObject({ outcome: "FAILED", refusedBeforeStreamCalls: 2 });
    expect(sent).toEqual([]);
    const read = readUsagePayload(report);
    expect(read).toEqual({ usage: { provider: "rovara-route", modelId: "gpt-5", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(read).not.toHaveProperty("reportedMicros");
  });
});
