// LESSONS-LEARNING-CODE-SIDE: the lessons' learning port over the model gateway's learning route (Cloud #57). An injected fetch stands in for the gateway; nothing reaches a network.
import { describe, expect, it, vi } from "vitest";
import { LESSONS_PAUSE_CODES, LESSONS_PAUSE_TEXT } from "@agentx/contracts";
import { LEARNING_CALL_FAILED, LEARNING_CALL_STEP, LEARNING_NOT_AVAILABLE, createGatewayLearningModel, gatewayLearningSpend } from "../../../packages/broker/src/lessons/gateway-learning.js";
import { LearningRefusal } from "../../../packages/broker/src/lessons/pause.js";

const CALL = { purpose: "reflect" as const, system: "You write lessons.", user: "What did this task teach?", maxOutputTokens: 800, workspaceId: "org_staging0000000000001", project: "payments" };
const TOKEN = "learning-token-for-one-call";
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function model(reply: () => Response | Promise<Response>, token: () => Promise<{ token: string; model: string } | undefined> = async () => ({ token: TOKEN, model: "claude-sonnet" })) {
  const fetch = vi.fn(async (_url: URL | string, _init?: RequestInit) => await reply());
  return { fetch, model: createGatewayLearningModel({ gatewayUrl: "https://gateway.example", token, fetch: fetch as unknown as typeof globalThis.fetch }) };
}

describe("the learning call through the gateway", () => {
  it("posts an Anthropic Messages request to /v1/learning/messages with the call's learning token, and answers the text", async () => {
    const { fetch, model: learning } = model(() => answer(200, { model: "claude-sonnet-4", content: [{ type: "text", text: "Lesson: " }, { type: "text", text: "pin the retry." }] }, { "x-rovara-cost-usd": "0.0125" }));
    expect(await learning.complete(CALL)).toEqual({ text: "Lesson: pin the retry.", costUsd: 0.0125, model: "claude-sonnet-4" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://gateway.example/v1/learning/messages");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(TOKEN);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "claude-sonnet", max_tokens: 800, system: CALL.system, messages: [{ role: "user", content: CALL.user }] });
    expect(LEARNING_CALL_STEP).toBe("rovara-lessons-learning-call");
  });

  it("maps the gateway's lessons_paused refusal to a learning refusal with the code it names, and an unknown code to model_failed", async () => {
    expect(LESSONS_PAUSE_CODES).toContain("lessons_off");
    expect(LESSONS_PAUSE_TEXT.lessons_off).toBe("Lessons paused: lessons are turned off for this company");
    for (const [header, code] of [["lessons_off", "lessons_off"], ["monthly_limit", "monthly_limit"], ["something-new", "model_failed"]] as const) {
      const { model: learning } = model(() => answer(403, { type: "error", error: { type: "lessons_paused", message: "zzq secret detail" } }, { "x-rovara-lessons-pause": header }));
      const refused = await learning.complete(CALL).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LearningRefusal);
      expect((refused as LearningRefusal).code).toBe(code);
      expect((refused as Error).message).not.toContain("zzq");
    }
  });

  it("treats 429 (budget held, busy), 502, 503, an unreadable body and a network failure as ordinary failures in fixed words, never echoing what came back", async () => {
    const replies: Array<() => Response | Promise<Response>> = [
      () => answer(429, { error: { type: "budget_held", message: "zzq" } }), () => answer(429, { error: { type: "busy" } }), () => answer(502, "zzq bad gateway"), () => answer(503, ""),
      () => answer(200, "zzq not json"), () => answer(200, { content: "zzq" }), () => answer(200, { content: [null] }), () => Promise.reject(new Error("zzq socket")),
    ];
    for (const reply of replies) {
      const failed = await model(reply).model.complete(CALL).catch((error: unknown) => error);
      expect(failed).not.toBeInstanceOf(LearningRefusal);
      expect((failed as Error).message).toBe(LEARNING_CALL_FAILED);
    }
  });

  it("refuses as no_provider, sending nothing, when no learning token can be made for the call", async () => {
    for (const token of [async () => undefined, async () => { throw new Error("zzq signer"); }]) {
      const { fetch, model: learning } = model(() => answer(200, { content: [] }), token);
      const refused = await learning.complete(CALL).catch((error: unknown) => error);
      expect((refused as LearningRefusal).code).toBe("no_provider");
      expect((refused as Error).message).toBe(LEARNING_NOT_AVAILABLE);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("never reports a negative or unreadable cost, and refuses a gateway address that is not https (loopback http allowed)", async () => {
    expect((await model(() => answer(200, { content: [] }, { "x-rovara-cost-usd": "-3" })).model.complete(CALL)).costUsd).toBe(0);
    expect(() => createGatewayLearningModel({ gatewayUrl: "http://gateway.example", token: async () => undefined })).toThrow("the learning gateway address must be https");
    expect(() => createGatewayLearningModel({ gatewayUrl: "http://127.0.0.1:8787", token: async () => undefined })).not.toThrow();
  });

  it("leaves the learning limit to the gateway: the core's own look always answers ok", async () => {
    const spend = gatewayLearningSpend();
    expect(await spend.admit("org_staging0000000000001", 5)).toBe(true);
    expect(await spend.look!("org_staging0000000000001", 5)).toBe("ok");
  });
});
