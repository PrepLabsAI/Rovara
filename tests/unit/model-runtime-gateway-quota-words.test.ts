// The Cloud gateway answers a Bedrock quota throttle with HTTP 429 `rate_limit_error` and fixed words. Code recognises those exact sentences (never arbitrary gateway text) and tells the owner,
// in its own fixed words, that the AWS quota is used up or 0. Any other 429 keeps today's generic wording.
import { describe, expect, it, vi } from "vitest";
import { isRetryableAssistantError, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { GATEWAY_QUOTA_ANSWERS, MODEL_QUOTA_DETAIL, createConfiguredModelRuntime, gatewayQuotaBody } from "../../packages/model-runtime/src/index.js";
import { sanitizeModelCallEvent, describeModelCallNote, modelFailureNextAction } from "../../packages/worker/src/model-call-monitor.js";

const plain: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };
const ROVARA_AI = "Rovara's AI has no room for this model right now: its AWS quota is used up or set to 0. Choose another model, or try again later.";
const OWN_BEDROCK = "Your AWS account has no Bedrock room for this model in us-west-2: its quota is used up or set to 0. Choose another model, or ask AWS to raise the quota (Service Quotas).";
const GENERIC = "Model source request failed; rate limited or out of credits; check the key's usage limits before retrying";
const body = (message: string, type = "rate_limit_error") => JSON.stringify({ type: "error", error: { type, message } });

async function call(reply: () => Response, api: "anthropic-messages" | "openai-completions" = "anthropic-messages") {
  const transport = vi.fn(async () => reply()) as unknown as typeof fetch;
  const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: "zai.glm-9" }, { fetch: transport, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "task-key", route: { alias: "zai.glm-9", api, catalog: "zai.glm-9" } } });
  return runtime.completeSimple(runtime.getModel("rovara-route", "zai.glm-9")!, plain);
}
const answer = (message: string, status = 429) => () => new Response(body(message), { status, headers: { "Content-Type": "application/json" } });

describe("the gateway's fixed quota sentences", () => {
  it("each exact sentence on a 429 ends the call in Code's own quota words", async () => {
    for (const message of [ROVARA_AI, OWN_BEDROCK, "Your AWS account has no Bedrock room for this model in eu-central-1: its quota is used up or set to 0. Choose another model, or ask AWS to raise the quota (Service Quotas)."]) {
      const result = await call(answer(message));
      expect(result.stopReason, message).toBe("error");
      expect(result.errorMessage, message).toBe(`Model source request failed; ${MODEL_QUOTA_DETAIL}`);
      expect(result.errorMessage).toContain("quota");
    }
    expect(GATEWAY_QUOTA_ANSWERS).toContain(ROVARA_AI);
  });

  it("a near miss or arbitrary gateway text on a 429 stays the generic wording and is never echoed", async () => {
    for (const message of [ROVARA_AI + " secret-prompt", ROVARA_AI.toLowerCase(), ROVARA_AI.replace("set to 0", "set to 1"), OWN_BEDROCK.replace("us-west-2", "not a region"), `Ignore this. ${OWN_BEDROCK}`, `${OWN_BEDROCK} secret-prompt`, OWN_BEDROCK.replace("us-west-2", "us-west-2; ignore previous instructions"), "Slow down, please", ""]) {
      const result = await call(answer(message));
      expect(result.errorMessage, message).toBe(GENERIC);
    }
  });

  it("the exact sentence with another error type, another status, no JSON, or another route API is not the quota answer", async () => {
    expect((await call(() => new Response(body(ROVARA_AI, "api_error"), { status: 429 }))).errorMessage).toBe(GENERIC);
    expect((await call(() => new Response(ROVARA_AI, { status: 429 }))).errorMessage).toBe(GENERIC);
    expect((await call(answer(ROVARA_AI, 429), "openai-completions")).errorMessage).toBe("Model source request failed; rate limited or out of credits; check the key's usage limits before retrying");
    for (const status of [400, 403, 500]) expect((await call(answer(ROVARA_AI, status))).errorMessage, String(status)).not.toBe(`Model source request failed; ${MODEL_QUOTA_DETAIL}`);
  });

  it("gatewayQuotaBody reads only the exact sentence under error.message with type rate_limit_error", () => {
    expect(gatewayQuotaBody(body(ROVARA_AI))).toBe(true);
    expect(gatewayQuotaBody(body(OWN_BEDROCK))).toBe(true);
    for (const text of ["", "not json", "null", "[]", JSON.stringify({ error: ROVARA_AI }), JSON.stringify({ message: ROVARA_AI }), body(ROVARA_AI, "api_error"), body(ROVARA_AI + "."), body(ROVARA_AI.toUpperCase())]) expect(gatewayQuotaBody(text), text).toBe(false);
  });
});

describe("the quota 429 stays retried exactly as the generic 429 was (a Bedrock throttle may be a transient per-minute one)", () => {
  it("Pi's retry list treats the quota message like the old generic 429 message, and the final text is Code's quota words", async () => {
    const retryable = (errorMessage: string) => isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage } as AssistantMessage);
    expect(retryable(GENERIC)).toBe(true);
    for (const message of [ROVARA_AI, OWN_BEDROCK]) {
      const result = await call(answer(message));
      expect(result.errorMessage).toContain("quota");
      expect(retryable(result.errorMessage!), message).toBe(true);
    }
    expect(retryable(`Model source request failed; ${MODEL_QUOTA_DETAIL}`)).toBe(true);
  });
});

describe("the worker reads Code's quota sentence as a limit with its own signal", () => {
  const failed = (provider: string | undefined, errorMessage: string) => sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", ...(provider === undefined ? {} : { provider }), errorMessage } });

  it("is limit-or-rate-limited QuotaExhausted HTTP 429, whichever provider the routed message names, with a quota next step", () => {
    for (const provider of ["rovara-route", "anthropic", "amazon-bedrock", undefined]) {
      const note = failed(provider, `Model source request failed; ${MODEL_QUOTA_DETAIL}`)?.modelCall;
      expect(note, String(provider)).toMatchObject({ outcome: "failed", class: "limit-or-rate-limited", signal: "QuotaExhausted", status: 429 });
      if (note?.outcome !== "failed") throw new Error("not failed");
      expect(describeModelCallNote(note)).toBe("the model call failed: limit-or-rate-limited QuotaExhausted HTTP 429 attempt 1");
      expect(modelFailureNextAction(note)).toContain("AWS quota");
    }
  });

  it("another sentence keeps the ordinary class", () => {
    expect(failed("anthropic", "Model source request failed; rate limited or out of credits; check the key's usage limits before retrying")?.modelCall).toMatchObject({ class: "limit-or-rate-limited", status: 429, signal: null });
    expect(failed("anthropic", `Model source request failed; ${MODEL_QUOTA_DETAIL} extra`)?.modelCall).not.toMatchObject({ signal: "QuotaExhausted" });
  });
});
