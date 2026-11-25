// LESSONS-LEARNING-CODE-SIDE: the lessons' learning port over the model gateway's learning route (Cloud #57). An injected fetch stands in for the gateway; nothing reaches a network.
import { describe, expect, it, vi } from "vitest";
import { LESSONS_PAUSE_CODES, LESSONS_PAUSE_TEXT } from "@agentx/contracts";
import { LEARNING_CALL_FAILED, LEARNING_CALL_STEP, LEARNING_NOT_AVAILABLE, createGatewayLearningModel, gatewayLearningSpend } from "../../../packages/broker/src/lessons/gateway-learning.js";
import { LearningRefusal } from "../../../packages/broker/src/lessons/pause.js";
import { withLearningAttempt, type LearningAttempt } from "../../../packages/broker/src/lessons/learning-deadline.js";

const CALL = { purpose: "reflect" as const, system: "You write lessons.", user: "What did this task teach?", maxOutputTokens: 800, workspaceId: "org_staging0000000000001", project: "payments" };
const TOKEN = "learning-token-for-one-call";
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function model(reply: () => Response | Promise<Response>, token: () => Promise<{ token: string; model: string } | undefined> = async () => ({ token: TOKEN, model: "claude-sonnet" })) {
  const fetch = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(async () => await reply());
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
    expect(JSON.parse(init?.body as string)).toEqual({ model: "claude-sonnet", max_tokens: 800, system: CALL.system, messages: [{ role: "user", content: CALL.user }] });
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

  it("never follows a redirect (the token would go elsewhere): any 3xx is a failed call, and the request says so", async () => {
    const { fetch, model: learning } = model(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }));
    expect(((await learning.complete(CALL).catch((error: unknown) => error)) as Error).message).toBe(LEARNING_CALL_FAILED);
    expect(fetch.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  it("reports the call's budget when the gateway gives no cost, and never more than the budget", async () => {
    const withBudget = { ...CALL, budgetUsd: 0.05 };
    expect((await model(() => answer(200, { content: [] })).model.complete(withBudget)).costUsd).toBe(0.05);
    expect((await model(() => answer(200, { content: [] }, { "x-rovara-cost-usd": "9" })).model.complete(withBudget)).costUsd).toBe(0.05);
    expect((await model(() => answer(200, { content: [] }, { "x-rovara-cost-usd": "0.01" })).model.complete(withBudget)).costUsd).toBe(0.01);
    expect((await model(() => answer(200, { content: [] })).model.complete(CALL)).costUsd).toBe(0);
  });

  it("leaves the learning limit to the gateway: the core's own look always answers ok", async () => {
    const spend = gatewayLearningSpend();
    expect(await spend.admit("org_staging0000000000001", 5)).toBe(true);
    expect(await spend.look!("org_staging0000000000001", 5)).toBe("ok");
  });

  describe("inside a reflection attempt (LP-14)", () => {
    const attemptOf = (over: Partial<LearningAttempt> = {}): LearningAttempt & { marks: string[]; fault?: "retryable" | "final" } => {
      const marks: string[] = [];
      return { deadlineAt: Date.now() + 240_000, marks, callStarting: async () => { marks.push("start"); }, callNotSent: async () => { marks.push("not-sent"); }, ...over };
    };
    it("marks the lease BEFORE the request is sent, and keeps the mark for a call that was sent, whatever came back", async () => {
      // The gateway's own error shapes after a provider call (`provider_error` 502 may follow a charged provider answer) keep the mark too: only `lessons_paused` / the install pause take it back.
      for (const reply of [() => answer(200, { content: [] }), () => answer(502, "bad"), () => answer(502, { type: "error", error: { type: "provider_error", message: "provider unavailable" } }), () => answer(429, { type: "error", error: { type: "budget_held" } }), () => answer(403, { type: "error", error: { type: "not_allowed", message: "request not allowed" } }), () => Promise.reject(new Error("socket")), () => new Response(null, { status: 307 })]) {
        const attempt = attemptOf();
        const { fetch, model: learning } = model(reply);
        fetch.mockImplementationOnce(async () => { expect(attempt.marks).toEqual(["start"]); return await reply(); });
        await withLearningAttempt(attempt, () => learning.complete(CALL)).catch(() => undefined);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(attempt.marks).toEqual(["start"]);
      }
    });
    it("takes the mark back only for the gateway's own refusal (nothing sent to a provider, nothing spent)", async () => {
      const attempt = attemptOf();
      const { model: learning } = model(() => answer(403, { error: { type: "lessons_paused" } }, { "x-rovara-lessons-pause": "monthly_limit" }));
      await withLearningAttempt(attempt, () => learning.complete(CALL)).catch(() => undefined);
      expect(attempt.marks).toEqual(["start", "not-sent"]);
    });
    it("a mark that cannot be written means no request is sent, and the fault is retryable (nothing was spent)", async () => {
      const attempt = attemptOf({ callStarting: async () => { throw new Error("the lease is no longer this attempt's"); } });
      const { fetch, model: learning } = model(() => answer(200, { content: [] }));
      expect(((await withLearningAttempt(attempt, () => learning.complete(CALL)).catch((error: unknown) => error)) as Error).message).toBe(LEARNING_CALL_FAILED);
      expect(fetch).not.toHaveBeenCalled();
      expect(attempt.fault).toBe("retryable");
    });
    it("a call that could not finish before the attempt's deadline is not sent and is retryable", async () => {
      const attempt = attemptOf({ deadlineAt: Date.now() + 500 });
      const { fetch, model: learning } = model(() => answer(200, { content: [] }));
      await withLearningAttempt(attempt, () => learning.complete(CALL)).catch(() => undefined);
      expect(fetch).not.toHaveBeenCalled();
      expect(attempt.marks).toEqual([]);
      expect(attempt.fault).toBe("retryable");
    });
    it("a failure after the call was sent is a final fault, on every path: a gateway error status, a network failure, a redirect and a malformed body", async () => {
      for (const reply of [() => answer(503, ""), () => Promise.reject(new Error("socket")), () => new Response(null, { status: 307 }), () => answer(200, { content: [null] }), () => answer(200, { content: "x" })]) {
        const attempt = attemptOf();
        await withLearningAttempt(attempt, () => model(reply).model.complete(CALL)).catch(() => undefined);
        expect(attempt.fault).toBe("final");
      }
    });
    it("the wait for the gateway never passes the attempt's deadline, and ends when the attempt's signal aborts (the call stays marked: the request may run on)", async () => {
      vi.useFakeTimers();
      try {
        const aborted: string[] = [];
        const hang = (): void => undefined;
        const asked = (attempt: LearningAttempt) => {
          const { fetch, model: learning } = model(() => new Promise<Response>(hang));
          fetch.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { aborted.push("abort"); reject(new Error("aborted")); }); }));
          return { done: withLearningAttempt(attempt, () => learning.complete(CALL)).catch((error: unknown) => error) };
        };
        // The deadline is 1.5 s away: the wait ends then, far inside the call's own 120 s timeout.
        const byDeadline = attemptOf({ deadlineAt: Date.now() + 1_500 });
        const first = asked(byDeadline);
        await vi.advanceTimersByTimeAsync(1_499);
        expect(aborted).toEqual([]);
        await vi.advanceTimersByTimeAsync(2);
        expect(((await first.done) as Error).message).toBe(LEARNING_CALL_FAILED);
        expect(aborted).toEqual(["abort"]);
        expect(byDeadline.marks).toEqual(["start"]);
        // The attempt's own signal ends the wait at once.
        const controller = new AbortController();
        const bySignal = attemptOf({ signal: controller.signal });
        const second = asked(bySignal);
        await vi.advanceTimersByTimeAsync(10);
        expect(aborted).toEqual(["abort"]);
        controller.abort();
        expect(((await second.done) as Error).message).toBe(LEARNING_CALL_FAILED);
        expect(aborted).toEqual(["abort", "abort"]);
        expect(bySignal.fault).toBe("final");
      } finally { vi.useRealTimers(); }
    });
  });
});
