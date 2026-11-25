import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { readFileSync } from "node:fs";
import { COMPANY_LIMIT_NOT_SET_MESSAGE, GATEWAY_STOPS, GATEWAY_STOP_CODES, ROVARA_AI_NOT_CONFIRMED_MESSAGE, gatewayStopOfText, isCompanyLimitNotSetText } from "../../packages/contracts/src/gateway-stops.js";
import { SETUP_RUN_CANNOT_REASONS } from "../../packages/contracts/src/setup-run.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { modelNotAllowedFromMarker } from "../../packages/model-runtime/src/budget.js";
import { COMPANY_LIMIT_NOT_SET_CODE, COMPANY_LIMIT_NOT_SET_SIGNAL, companyLimitNotSetBody, gatewayStopBody } from "../../packages/model-runtime/src/provider-failure.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { sanitizeModelCallEvent } from "../../packages/worker/src/model-call-monitor.js";
import { modelCallView } from "../../packages/broker/src/developer/model-call-view.js";
import { finish, nextJob, taskOf, toDesignPhase, world as taskWorld } from "../support/design-review-flow-world.js";

// DEC 254zzz491: the hosted model gateway's 403 `company_limit_not_set` (the company has no monthly AI limit) is a STOP, not a retry and not a refused key. Code ends the call at once, the step blocks with the
// shared sentence, and the setup run fails with it. Cloud matches that sentence as a substring to show its fix-it card, so the words are pinned here, whole.
const SENTENCE = "No monthly AI limit is set for your company. Set one in Admin, AI and spending.";
const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const gatewayBody = { error: { type: "company_limit_not_set", message: SENTENCE, link: "/app/admin/ai-spending" } };
const answered = (status: number, body: unknown = gatewayBody) => Response.json(body, { status });

async function runCall(reply: () => Response, options: { api?: "anthropic-messages" | "openai-responses" | "openai-completions"; route?: boolean; providerRetries?: number } = {}) {
  let calls = 0;
  const counted = { fetch: (async () => { calls++; return reply(); }) as unknown as typeof fetch, onUsage: () => undefined };
  const runtime = options.route === false
    ? await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { ...counted, environment: { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf" }, readSecret: async () => `not-a-real-key-${"0".repeat(40)}` })
    : await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { ...counted, proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: options.api ?? "anthropic-messages", catalog: MODEL } } });
  const model = options.route === false ? runtime.getModel("anthropic", MODEL)! : runtime.getModel("rovara-route", MODEL)!;
  const message = await runtime.completeSimple(model, context, options.providerRetries === undefined ? undefined : { maxRetries: options.providerRetries, maxRetryDelayMs: 0 });
  return { message, calls: () => calls };
}

describe("the shared words", () => {
  it("are the owner's sentence, in one constant, and the gateway's code is pinned", () => {
    expect(COMPANY_LIMIT_NOT_SET_MESSAGE).toBe(SENTENCE);
    expect(COMPANY_LIMIT_NOT_SET_CODE).toBe("company_limit_not_set");
    expect(isCompanyLimitNotSetText(SENTENCE)).toBe(true);
    expect(isCompanyLimitNotSetText(`MODEL_NOT_ALLOWED: ${SENTENCE}`)).toBe(true);
    for (const text of [`${SENTENCE} extra`, SENTENCE.slice(0, -1), "", undefined, null, `RUNTIME_UNAVAILABLE: ${SENTENCE}`]) expect(isCompanyLimitNotSetText(text)).toBe(false);
  });
});

describe("the gateway's 403 company_limit_not_set is a stop", () => {
  it.each([["anthropic-messages"], ["openai-responses"], ["openai-completions"]] as const)("the %s route: exactly one call (even when provider retries are allowed), the sentence, not retryable", async (api) => {
    const { message, calls } = await runCall(() => answered(403), { api, providerRetries: 2 });
    expect(calls()).toBe(1);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(SENTENCE);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(message.usage.totalTokens).toBe(0);
    expect(message.usage.cost.total).toBe(0);
  });

  it("a body naming the code as `code`, with any message, still gives Code's own sentence (the gateway's words are never copied)", async () => {
    const { message } = await runCall(() => answered(403, { error: { code: "company_limit_not_set", message: "something else the gateway said" } }));
    expect(message.errorMessage).toBe(SENTENCE);
  });

  it("the step stops with the plain reason: MODEL_NOT_ALLOWED, terminal, with or without a monitor", async () => {
    const { message } = await runCall(() => answered(403));
    for (const monitoring of [undefined, { note: undefined }]) {
      expect(failedTurn(message, monitoring)).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${SENTENCE}` });
    }
    expect(modelNotAllowedFromMarker(SENTENCE)?.text).toBe(SENTENCE);
  });

  it("a 503 is still a provider outage, retried as before, with the gateway's words dropped", async () => {
    const outage = await runCall(() => answered(503), { providerRetries: 2 });
    expect(outage.calls()).toBe(3);
    expect(outage.message.errorMessage).toBe("Model source request failed; upstream unavailable; check provider status before retrying");
    expect(outage.message.errorMessage).not.toBe(SENTENCE);
    // The code on the other 5xx and 4xx statuses is not the stop either.
    for (const status of [400, 401, 404, 409, 422, 429, 500, 502]) {
      const { message } = await runCall(() => answered(status));
      expect(message.errorMessage, String(status)).not.toBe(SENTENCE);
    }
  });

  it("other 403s are unchanged: the words and the not-a-retry of a 403", async () => {
    for (const body of [{ error: { type: "permission_error", message: "x" } }, { error: { type: "company_limit_not_set_extra" } }, { error: { type: "COMPANY_LIMIT_NOT_SET" } }, { error: "company_limit_not_set" }, { type: "company_limit_not_set" }, {}, null]) {
      const { message, calls } = await runCall(() => answered(403, body), { providerRetries: 2 });
      expect(message.errorMessage, JSON.stringify(body)).toBe("Model source request failed; check the API key and its permissions");
      expect(isRetryableAssistantError(message)).toBe(false);
      expect(calls()).toBe(1);
    }
    const plain = await runCall(() => new Response("not json", { status: 403 }));
    expect(plain.message.errorMessage).toBe("Model source request failed; check the API key and its permissions");
  });

  it("a call with no gateway route (the person's own key) does not read the code", async () => {
    const { message } = await runCall(() => answered(403), { route: false });
    expect(message.errorMessage).not.toBe(SENTENCE);
  });

  it("is told by the gateway's exact 403 body only", () => {
    expect(companyLimitNotSetBody(403, JSON.stringify({ error: { type: COMPANY_LIMIT_NOT_SET_CODE } }))).toBe(true);
    expect(companyLimitNotSetBody(403, JSON.stringify({ error: { code: COMPANY_LIMIT_NOT_SET_CODE } }))).toBe(true);
    for (const [status, body] of [[503, gatewayBody], [500, gatewayBody], [429, gatewayBody], [409, gatewayBody], [402, gatewayBody], [403, {}], [403, null], [403, []], [403, { error: COMPANY_LIMIT_NOT_SET_CODE }], [403, { type: COMPANY_LIMIT_NOT_SET_CODE }], [403, { error: { type: "other" } }]] as const) {
      expect(companyLimitNotSetBody(status, JSON.stringify(body)), `${status} ${JSON.stringify(body)}`).toBe(false);
    }
    expect(companyLimitNotSetBody(403, "not json")).toBe(false);
    expect(companyLimitNotSetBody(403, "")).toBe(false);
  });
});

describe("what the task page and the event feed say", () => {
  const failed = { type: "message_end", message: { role: "assistant", stopReason: "error", provider: "anthropic", errorMessage: SENTENCE } };

  it("the monitor notes the refusal under a stable signal, with status 403, instead of `unknown`", () => {
    expect(COMPANY_LIMIT_NOT_SET_SIGNAL).toBe("CompanyLimitNotSet");
    expect(sanitizeModelCallEvent(failed, 1)).toEqual({ modelCall: { outcome: "failed", class: "request-rejected", signal: COMPANY_LIMIT_NOT_SET_SIGNAL, attempt: 1, provider: "anthropic", status: 403 } });
    expect(sanitizeModelCallEvent({ ...failed, message: { ...failed.message, errorMessage: `${SENTENCE} extra` } }, 1)).toMatchObject({ modelCall: { class: "unknown" } });
  });

  it("the monitored operation error is the plain sentence", () => {
    const note = sanitizeModelCallEvent(failed, 2)?.modelCall;
    const error = failedTurn({ stopReason: "error", errorMessage: SENTENCE, provider: "anthropic" }, { note });
    expect(error?.message).toBe(`MODEL_NOT_ALLOWED: ${SENTENCE}`);
  });

  it("the event list shows the sentence for the stable signal on 403 only", () => {
    expect(modelCallView(sanitizeModelCallEvent(failed, 1))).toEqual({ kind: "error", text: SENTENCE });
    expect(modelCallView({ modelCall: { outcome: "failed", class: "request-rejected", signal: COMPANY_LIMIT_NOT_SET_SIGNAL, attempt: 1, provider: "anthropic", status: 400 } })?.text).not.toBe(SENTENCE);
  });
});

describe("the task flow blocks the step with the sentence and waits for Retry", () => {
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

  it("a longer text that only contains the sentence is not the stop", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${SENTENCE} (and more)`);
    expect((await taskOf(w)).workflow.blockReason).not.toBe(SENTENCE);
  });
});

// The second gateway stop (owner's amendment to DEC 254zzz491): 403 `rovara_ai_not_confirmed`, handled by the same GATEWAY_STOPS table.
describe("the gateway's 403 rovara_ai_not_confirmed is the same kind of stop", () => {
  const NOT_CONFIRMED = "Choose how Rovara pays for AI: confirm Rovara AI, billed to your company, up to your monthly limit, or connect your own AI key.";
  const body = { error: { type: "rovara_ai_not_confirmed", message: "gateway words that are never copied" } };
  const failed = { type: "message_end", message: { role: "assistant", stopReason: "error", provider: "anthropic", errorMessage: NOT_CONFIRMED } };

  it("the words, the code and the signal are pinned, and the two stops are never mixed up", () => {
    expect(ROVARA_AI_NOT_CONFIRMED_MESSAGE).toBe(NOT_CONFIRMED);
    expect(GATEWAY_STOPS.rovara_ai_not_confirmed).toEqual({ status: 403, message: NOT_CONFIRMED, signal: "RovaraAiNotConfirmed" });
    expect(gatewayStopOfText(NOT_CONFIRMED)).toBe("rovara_ai_not_confirmed");
    expect(gatewayStopOfText(`MODEL_NOT_ALLOWED: ${NOT_CONFIRMED}`)).toBe("rovara_ai_not_confirmed");
    expect(gatewayStopOfText(`${NOT_CONFIRMED} extra`)).toBeUndefined();
    expect(isCompanyLimitNotSetText(NOT_CONFIRMED)).toBe(false);
    expect(gatewayStopBody(403, JSON.stringify(body))).toBe("rovara_ai_not_confirmed");
    expect(gatewayStopBody(403, JSON.stringify(gatewayBody))).toBe("company_limit_not_set");
    for (const status of [400, 401, 402, 404, 409, 429, 500, 503]) expect(gatewayStopBody(status, JSON.stringify(body)), String(status)).toBeUndefined();
  });

  it.each([["anthropic-messages"], ["openai-responses"], ["openai-completions"]] as const)("the %s route: one call, the sentence, not retryable, a terminal not-allowed error (not a refused key)", async (api) => {
    const { message, calls } = await runCall(() => answered(403, body), { api, providerRetries: 2 });
    expect(calls()).toBe(1);
    expect(message.errorMessage).toBe(NOT_CONFIRMED);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(failedTurn(message)).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${NOT_CONFIRMED}` });
    expect(failedTurn(message, { note: sanitizeModelCallEvent({ ...failed, message: { ...failed.message, errorMessage: message.errorMessage } }, 1)?.modelCall })).toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });

  it("a 503 carrying the code is still a retried outage; the own-key route does not read it", async () => {
    const outage = await runCall(() => answered(503, body), { providerRetries: 2 });
    expect(outage.calls()).toBe(3);
    expect(outage.message.errorMessage).not.toBe(NOT_CONFIRMED);
    expect((await runCall(() => answered(403, body), { route: false })).message.errorMessage).not.toBe(NOT_CONFIRMED);
  });

  it("the note, the event list and the blocked step carry the sentence", async () => {
    expect(sanitizeModelCallEvent(failed, 1)).toEqual({ modelCall: { outcome: "failed", class: "request-rejected", signal: "RovaraAiNotConfirmed", attempt: 1, provider: "anthropic", status: 403 } });
    expect(modelCallView(sanitizeModelCallEvent(failed, 1))).toEqual({ kind: "error", text: NOT_CONFIRMED });
    expect(modelCallView({ modelCall: { outcome: "failed", class: "request-rejected", signal: "RovaraAiNotConfirmed", attempt: 1, provider: "anthropic", status: 400 } })?.text).not.toBe(NOT_CONFIRMED);
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${NOT_CONFIRMED}`);
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: NOT_CONFIRMED });
  });
});

describe("the setup run's `cannot` reasons cannot drift from the gateway's stops", () => {
  it("setup-run.ts lists `company_off` plus exactly the GATEWAY_STOPS codes, and imports only zod", () => {
    expect([...SETUP_RUN_CANNOT_REASONS]).toEqual(["company_off", ...GATEWAY_STOP_CODES]);
    const imports = [...readFileSync("packages/contracts/src/setup-run.ts", "utf8").matchAll(/^import [^;]*? from "([^"]+)";/gmu)].map((match) => match[1]);
    expect(imports).not.toContain("./gateway-stops.js");
  });
});
