import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { modelNotAllowedFromMarker } from "../../packages/model-runtime/src/budget.js";
import { RUN_PRICE_REFUSED_CODE, RUN_PRICE_REFUSED_MESSAGE, RUN_PRICE_REFUSED_SIGNAL, runPriceRefusedBody } from "../../packages/model-runtime/src/provider-failure.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { sanitizeModelCallEvent } from "../../packages/worker/src/model-call-monitor.js";
import { modelCallView } from "../../packages/broker/src/developer/model-call-view.js";
import { PI_MODEL_RETRY } from "../../packages/model-runtime/src/pi-settings.js";
import { finish, nextJob, taskOf, toDesignPhase, world as taskWorld } from "../support/design-review-flow-world.js";

// RUN-PRICE-REFUSAL-STOP: the hosted model gateway's 409 `run_price_authorization_required` is a STOP, not a retry. Code ends the call at once (one request, no Pi retry, no SDK retry),
// the step stops with a plain reason, and nothing is spent. Retry on the blocked step starts a new run, which mints a fresh price authorization (route.ts handleModelAccess).
const SENTENCE = "The AI price authorization changed. Start the step again to re-authorize.";
const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const refused = (status = 409, error: Record<string, unknown> = { type: "run_price_authorization_required", message: "AI source or price changed; pause this run for fresh authorization." }) => Response.json({ error }, { status });
// The Bedrock route's refusalBody shape: `{ message, error: { type, message } }`.
const bedrockShaped = () => Response.json({ message: "m", error: { type: "run_price_authorization_required", message: "m" } }, { status: 409 });

async function runCall(reply: () => Response, options: { route?: boolean; providerRetries?: number } = {}) {
  let calls = 0;
  const usage: Array<Record<string, unknown>> = [];
  const counted = { fetch: (async () => { calls++; return reply(); }) as unknown as typeof fetch, onUsage: (record: unknown) => { usage.push(record as Record<string, unknown>); } };
  // `route: false` is a keyed Anthropic call (the person's own key), not the hosted gateway route.
  const runtime = options.route === false
    ? await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { ...counted, environment: { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf" }, readSecret: async () => `not-a-real-key-${"0".repeat(40)}` })
    : await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { ...counted, proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } } });
  const model = options.route === false ? runtime.getModel("anthropic", MODEL)! : runtime.getModel("rovara-route", MODEL)!;
  const message = await runtime.completeSimple(model, context, options.providerRetries === undefined ? undefined : { maxRetries: options.providerRetries, maxRetryDelayMs: 0 });
  return { message, calls: () => calls, usage };
}

describe("the gateway's run price refusal is a stop", () => {
  it("the words are the owner's sentence and the code is the gateway's", () => {
    expect(RUN_PRICE_REFUSED_MESSAGE).toBe(SENTENCE);
    expect(RUN_PRICE_REFUSED_CODE).toBe("run_price_authorization_required");
  });

  it.each([["the default body", () => refused()], ["the Bedrock-shaped body", bedrockShaped], ["a body naming it as `code`", () => refused(409, { code: "run_price_authorization_required", message: "x" })]])("%s: exactly one call, no retry, the fixed sentence, nothing spent", async (_name, reply) => {
    const { message, calls, usage } = await runCall(reply);
    expect(calls()).toBe(1);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(SENTENCE);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(message.usage.totalTokens).toBe(0);
    expect(message.usage.cost.total).toBe(0);
    expect(usage.every(record => (record.tokens as { input: number; output: number }).input === 0 && (record.tokens as { output: number }).output === 0 && record.costUsd === null)).toBe(true);
  });

  it("the step stops with the plain reason: MODEL_NOT_ALLOWED, terminal, with or without a monitor", async () => {
    const { message } = await runCall(() => refused());
    for (const monitoring of [undefined, { note: undefined }]) {
      expect(failedTurn(message, monitoring)).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${SENTENCE}` });
    }
    expect(modelNotAllowedFromMarker(SENTENCE)?.text).toBe(SENTENCE);
  });

  it("even if the caller asks for provider-level retries, the refusal is still one call (x-should-retry: false); an ordinary 409 is retried as before", async () => {
    const stop = await runCall(() => refused(), { providerRetries: 2 });
    expect(stop.calls()).toBe(1);
    expect(stop.message.errorMessage).toBe(SENTENCE);
    const ordinary = await runCall(() => refused(409, { type: "something_else", message: "x" }), { providerRetries: 2 });
    expect(ordinary.calls()).toBe(3);
  });

  it("other 409s keep today's words and stay retryable (no stop)", async () => {
    for (const error of [{ type: "agent_budget_required", message: "x" }, { type: "something_else", message: "x" }, { type: "run_price_authorization_required_extra", message: "x" }, {}]) {
      const { message } = await runCall(() => refused(409, error));
      expect(message.errorMessage, JSON.stringify(error)).toBe("Model source request failed; check credentials, model availability, rate limits and provider status");
      expect(isRetryableAssistantError(message)).toBe(true);
    }
    const plain = await runCall(() => new Response("not json", { status: 409 }));
    expect(plain.message.errorMessage).toBe("Model source request failed; check credentials, model availability, rate limits and provider status");
  });

  it("the code on any other status is not the stop; 5xx and 429 keep their retryable words", async () => {
    for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
      const { message } = await runCall(() => refused(status));
      expect(message.errorMessage, String(status)).not.toBe(SENTENCE);
    }
    // Unchanged: the status-chosen words (429 names a rate limit, which Pi retries; 5xx the provider's outage words) and the client's own retry of a 5xx.
    const words = new Map([[429, "rate limited or out of credits; check the key's usage limits before retrying"], [500, "upstream unavailable; check provider status before retrying"], [503, "upstream unavailable; check provider status before retrying"]]);
    for (const [status, detail] of words) {
      const { message, calls } = await runCall(() => refused(status, { type: "api_error", message: "x" }));
      expect(message.errorMessage, String(status)).toBe(`Model source request failed; ${detail}`);
      expect(isRetryableAssistantError(message), String(status)).toBe(status === 429);
      expect(calls(), String(status)).toBeGreaterThanOrEqual(1);
    }
  });

  it("a call with no route (not the hosted gateway) does not read the code", async () => {
    const { message } = await runCall(() => refused(), { route: false });
    expect(message.errorMessage).not.toBe(SENTENCE);
  });

  it("is told by the gateway's exact 409 body only", () => {
    expect(runPriceRefusedBody(409, JSON.stringify({ error: { type: RUN_PRICE_REFUSED_CODE } }))).toBe(true);
    expect(runPriceRefusedBody(409, JSON.stringify({ error: { code: RUN_PRICE_REFUSED_CODE } }))).toBe(true);
    for (const [status, body] of [[400, { error: { type: RUN_PRICE_REFUSED_CODE } }], [403, { error: { type: RUN_PRICE_REFUSED_CODE } }], [500, { error: { type: RUN_PRICE_REFUSED_CODE } }],
      [409, {}], [409, null], [409, []], [409, { error: "run_price_authorization_required" }], [409, { type: RUN_PRICE_REFUSED_CODE }], [409, { error: { type: "RUN_PRICE_AUTHORIZATION_REQUIRED" } }]] as const) {
      expect(runPriceRefusedBody(status, JSON.stringify(body)), `${status} ${JSON.stringify(body)}`).toBe(false);
    }
    expect(runPriceRefusedBody(409, "not json")).toBe(false);
    expect(runPriceRefusedBody(409, "")).toBe(false);
  });

  it("Pi's retry budget is unchanged (other failures keep retrying as before)", () => {
    expect(PI_MODEL_RETRY).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 10_000 });
  });
});

describe("what the task page and the event feed say", () => {
  const failed = { type: "message_end", message: { role: "assistant", stopReason: "error", provider: "anthropic", errorMessage: SENTENCE } };

  it("the monitor notes the refusal under a stable signal instead of `unknown`", () => {
    expect(sanitizeModelCallEvent(failed, 1)).toEqual({ modelCall: { outcome: "failed", class: "request-rejected", signal: RUN_PRICE_REFUSED_SIGNAL, attempt: 1, provider: "anthropic", status: 409 } });
    // An ordinary unknown failure is still `unknown`, and a provider's own text that merely repeats the sentence on another stop reason is not read.
    expect(sanitizeModelCallEvent({ ...failed, message: { ...failed.message, errorMessage: "boom" } }, 1)).toMatchObject({ modelCall: { class: "unknown" } });
    expect(sanitizeModelCallEvent({ ...failed, message: { ...failed.message, errorMessage: `${SENTENCE} extra` } }, 1)).toMatchObject({ modelCall: { class: "unknown" } });
  });

  it("the monitored operation error is the plain sentence, not `unknown ... retry the step`", () => {
    const note = sanitizeModelCallEvent(failed, 3)?.modelCall;
    const error = failedTurn({ stopReason: "error", errorMessage: SENTENCE, provider: "anthropic" }, { note });
    expect(error?.message).toBe(`MODEL_NOT_ALLOWED: ${SENTENCE}`);
    expect(error?.message).not.toContain("unknown");
  });

  it("the event list shows the sentence for the stable signal, and keeps its words for everything else", () => {
    const note = sanitizeModelCallEvent(failed, 1);
    expect(modelCallView(note)).toEqual({ kind: "error", text: SENTENCE });
    const other = modelCallView({ modelCall: { outcome: "failed", class: "request-rejected", signal: "ValidationException", attempt: 1, provider: "amazon-bedrock", status: 400 } });
    expect(other?.text).toContain("request refused");
    expect(other?.text).not.toContain("price authorization");
    // The signal on another status is not the stop.
    expect(modelCallView({ modelCall: { outcome: "failed", class: "request-rejected", signal: RUN_PRICE_REFUSED_SIGNAL, attempt: 1, provider: "anthropic", status: 400 } })?.text).not.toBe(SENTENCE);
  });
});

describe("the task flow blocks the step with the plain reason and waits for Retry", () => {
  it("a FAILED run with the exact refusal blocks the running step with the sentence, once", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${SENTENCE}`);
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: SENTENCE });
    await w.h.flow.sweepOnce();
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: SENTENCE });
    expect((await w.h.flow.dispatchOnce({ maxMessages: 10 })).delivered).toBe(0);
  });

  it("Understand stops with the same reason", async () => {
    const w = await taskWorld();
    const prepare = await nextJob(w);
    await finish(w, prepare.operation, { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: "b".repeat(40) }] });
    const understand = await nextJob(w);
    expect(understand.operation.workflowMode).toBe("UNDERSTAND");
    await finish(w, understand.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${SENTENCE}`);
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: SENTENCE });
  });

  it("another MODEL_NOT_ALLOWED keeps its own reason (the sentence is matched whole)", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${SENTENCE} Extra.`);
    const task = await taskOf(w);
    expect(task.workflow.state).toBe("BLOCKED");
    expect(task.workflow.blockReason).toContain("Extra.");
    expect(task.workflow.blockReason).not.toBe(SENTENCE);
  });
});
