import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { RUN_PRICE_REFUSED_MESSAGE } from "../../packages/model-runtime/src/provider-failure.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { retryBlockedStep } from "../../packages/broker/src/core/task-flow/retry.js";
import { finish, nextJob, taskOf, toDesignPhase, world as taskWorld } from "../support/design-review-flow-world.js";

// Review tests (lead 4 Opus, RUN-PRICE-REFUSAL-STOP 06ac4228f): the OpenAI-format gateway routes, the network-error path, and the owner's Retry re-authorizing at exactly one new model access.
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const refused = (status = 409) => Response.json({ error: { type: "run_price_authorization_required", message: "AI source or price changed; pause this run for fresh authorization." } }, { status });

async function routed(api: "anthropic-messages" | "openai-responses" | "openai-completions", reply: () => Response | Promise<Response>, providerRetries?: number) {
  let calls = 0;
  const alias = "company-model";
  const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: alias }, {
    fetch: (async () => { calls++; return reply(); }) as unknown as typeof fetch, onUsage: () => undefined,
    proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias, api, catalog: alias } },
  });
  const message = await runtime.completeSimple(runtime.getModel("rovara-route", alias)!, context, providerRetries === undefined ? undefined : { maxRetries: providerRetries, maxRetryDelayMs: 0 });
  return { message, calls: () => calls };
}

describe("review: the stop on every hosted gateway route, and nothing else", () => {
  it.each(["openai-responses", "openai-completions"] as const)("the %s route stops the same way: one call, the sentence, not retryable", async (api) => {
    const { message, calls } = await routed(api, () => refused(), 2);
    expect(calls()).toBe(1);
    expect(message.errorMessage).toBe(RUN_PRICE_REFUSED_MESSAGE);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(failedTurn(message)).toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });

  it("a network error on the gateway route is never the stop (it stays the ordinary failure)", async () => {
    const { message } = await routed("anthropic-messages", () => { throw new TypeError("fetch failed"); });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).not.toBe(RUN_PRICE_REFUSED_MESSAGE);
    expect((failedTurn(message) as { code?: string } | undefined)?.code).not.toBe("MODEL_NOT_ALLOWED");
  });

  it("a 429 carrying the code is still a rate limit Pi retries", async () => {
    const { message } = await routed("anthropic-messages", () => refused(429));
    expect(message.errorMessage).not.toBe(RUN_PRICE_REFUSED_MESSAGE);
    expect(isRetryableAssistantError(message)).toBe(true);
  });
});

describe("review: the owner's Retry re-authorizes at exactly one new model access", () => {
  it("Retry on the blocked step starts exactly one new run, which is delivered once", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${RUN_PRICE_REFUSED_MESSAGE}`);
    const blocked = (await taskOf(w)).workflow;
    expect(blocked).toMatchObject({ state: "BLOCKED", blockReason: RUN_PRICE_REFUSED_MESSAGE });
    await retryBlockedStep(w.h.deps, w.taskId, blocked.revision);
    const again = await nextJob(w);
    expect(again.operation.id).not.toBe(job.operation.id);
    expect(again.operation.workflowMode).toBe(job.operation.workflowMode);
    expect((await taskOf(w)).workflow.state).not.toBe("BLOCKED");
    // Only the one new run: nothing else waits to be delivered.
    expect((await w.h.flow.dispatchOnce({ maxMessages: 10 })).delivered).toBe(0);
  });

  it("a new run's model access is asked of the broker once (one fresh runPrice), however many calls the run makes; the refused run's answer is never reused", async () => {
    const NOW = 1_800_000_000_000;
    const price = (n: number) => ({ companyId: "c", model: "claude-sonnet-5", provider: "anthropic", sourceId: "s", connectionRevision: 1, catalogModel: "claude-sonnet-5", inputUsdPerMTok: n, outputUsdPerMTok: 15, expiresAt: NOW + 3_600_000 });
    const answers: number[] = [];
    const broker = (n: number) => (async () => { answers.push(n); return Response.json({ baseUrl: "https://gateway.example", apiKey: `task-token-${String(n)}-${"a".repeat(32)}`, expiresAt: NOW + 3_600_000, runPrice: price(n) }); }) as unknown as typeof fetch;
    const refusedRun = modelAccessSource({ controlPlaneUrl: "https://cp.example", capability: "cap-1", fetch: broker(1), now: () => NOW });
    await refusedRun(); await refusedRun();
    const retried = modelAccessSource({ controlPlaneUrl: "https://cp.example", capability: "cap-2", fetch: broker(2), now: () => NOW });
    const first = await retried();
    await retried(); await retried();
    expect(answers).toEqual([1, 2]);
    expect(first.apiKey).toContain("task-token-2");
  });
});
