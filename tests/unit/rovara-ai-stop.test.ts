import { describe, expect, it } from "vitest";
import { isRovaraAiPaused } from "../../packages/contracts/src/model-sources.js";
import type { Context } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { createCompanyGatewayRuntime } from "../../packages/orchestrator/src/gateway-model.js";
import { turnRefusalWords } from "../../packages/slack-service/src/slack-company-models.js";
import { createGatewayLearningModel } from "../../packages/broker/src/lessons/gateway-learning.js";
import { LearningRefusal } from "../../packages/broker/src/lessons/pause.js";
import { createHttpAnswersGateway } from "../../packages/broker/src/core-host/gateway-answers.js";
import { createGatewayAnswerModel } from "../../packages/broker/src/core/answers/gateway-model.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { A, answer as finalAnswer, body, goodSentence, tool, world } from "../support/answer-world.js";
import { finish, nextJob, taskOf, toDesignPhase, world as taskWorld } from "../support/design-review-flow-world.js";

// The owner-approved sentence is the shared refusal: no second availability setting or new wire code.
const PAUSED = "Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.";
const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const refusal = (status = 403, message = PAUSED) => Response.json({ error: { type: "rovara_ai_paused", message } }, { status });
const answer = () => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("the shared gateway install stop in Code", () => {
  it.each([
    [403, true],
    [200, false],
    [401, false],
    [422, false],
    [500, false],
  ] as const)("classifies the exact pause sentence only with HTTP 403 (status %s)", (status, paused) => {
    // Answers passes JSON text; learning passes the parsed body; orchestrator passes JSON text.
    const body = { error: { type: "not_allowed", message: PAUSED } };
    expect(isRovaraAiPaused(status, body)).toBe(paused);
    expect(isRovaraAiPaused(status, JSON.stringify(body))).toBe(paused);
  });

  it("blocks the running workflow with the exact refusal and starts no follow-up run", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${PAUSED}`);
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: PAUSED });
    await w.h.flow.sweepOnce();
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: PAUSED });
    expect((await w.h.flow.dispatchOnce({ maxMessages: 10 })).delivered).toBe(0);
  });

  it("an ordinary worker failure keeps its own reason instead of becoming an install pause", async () => {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", "WORKER_DISCONNECTED");
    const task = await taskOf(w);
    expect(task.workflow.state).toBe("BLOCKED");
    expect(task.workflow.blockReason).toContain("WORKER_DISCONNECTED");
    expect(task.workflow.blockReason).not.toBe(PAUSED);
  });

  it("the exact install refusal also stops Understand with the exact reason", async () => {
    const w = await taskWorld();
    const prepare = await nextJob(w);
    await finish(w, prepare.operation, { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: "b".repeat(40) }] });
    const understand = await nextJob(w);
    expect(understand.operation.workflowMode).toBe("UNDERSTAND");
    await finish(w, understand.operation, undefined, "FAILED", `MODEL_NOT_ALLOWED: ${PAUSED}`);
    expect((await taskOf(w)).workflow).toMatchObject({ state: "BLOCKED", blockReason: PAUSED });
  });

  it.each(["agent", "setup", "upkeep", "reviewer", "e2e_agent"])("%s keeps the exact refusal with zero usage and no retryable failure", async purpose => {
    let calls = 0;
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: async () => { calls++; return refusal(); }, onUsage: () => undefined,
      proxy: { baseUrl: `https://gateway.example/v1/${purpose}`, apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages", catalog: MODEL } },
    });
    const message = await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(PAUSED);
    expect(message.usage.totalTokens).toBe(0);
    expect(message.usage.cost.total).toBe(0);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(calls).toBe(1);
    // A monitored running task and an unmonitored agent both retain the terminal refusal.
    for (const monitoring of [undefined, { note: undefined }]) {
      expect(failedTurn(message, monitoring)).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${PAUSED}` });
    }
  });

  it("a running runtime sees the stop on its next call without rebuilding or using a local cache", async () => {
    let paused = false;
    let calls = 0;
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, {
      fetch: async () => { calls++; return paused ? refusal() : answer(); }, onUsage: () => undefined,
      proxy: { baseUrl: "https://gateway.example", apiKey: "one-task-token", route: { alias: MODEL, api: "anthropic-messages", catalog: MODEL } },
    });
    const model = runtime.getModel("rovara-route", MODEL)!;
    expect((await runtime.completeSimple(model, context)).stopReason).toBe("stop");
    paused = true;
    const stopped = await runtime.completeSimple(model, context);
    expect(stopped.errorMessage).toBe(PAUSED);
    expect(calls).toBe(2);
  });

  it("Slack company chat displays the fixed install refusal rather than a monthly-limit or network failure", async () => {
    let calls = 0;
    const models = await createCompanyGatewayRuntime({ baseUrl: "https://gateway.example/v1/answers", model: MODEL, token: async () => "one-company-token", fetch: async () => { calls++; return refusal(); } });
    const message = await models.runtime.completeSimple(models.runtime.getModel(models.model.provider, models.model.modelId)!, context);
    expect(message.errorMessage).toBe(PAUSED);
    expect(turnRefusalWords({ kind: "gateway", models })).toBe(PAUSED);
    expect(calls).toBe(1);
  });

  it("learning refuses once with the exact words and an existing terminal pause code, never returning a charged result", async () => {
    let calls = 0;
    const learning = createGatewayLearningModel({ gatewayUrl: "https://gateway.example", token: async () => ({ token: "one-learning-token", model: MODEL }), fetch: async () => { calls++; return refusal(); } });
    const error: unknown = await learning.complete({ purpose: "reflect", system: "rules", user: "task", maxOutputTokens: 100, budgetUsd: 1, workspaceId: A, project: "alpha" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LearningRefusal);
    expect(error).toMatchObject({ code: "no_provider", message: PAUSED });
    expect(calls).toBe(1);
  });

  it.each([0, 1])("answers turn %s surfaces the refusal, releases its session, and records no invented answer", async stoppedTurn => {
    const w = world();
    w.roles.add(`${A}/alpha/ada`);
    let calls = 0;
    const gateway = createHttpAnswersGateway({ gatewayUrl: "https://gateway.example", issuer: "https://issuer.example", model: MODEL,
      signer: taskKeySigner({ sign: async () => Buffer.from("test-signature"), publicJwk: async () => ({ kty: "RSA", kid: "test-signing-key", alg: "RS256", use: "sig", n: "test", e: "AQAB" }) }),
      runPrice: async () => ({ ...runPriceFor(MODEL), companyId: A, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }),
      fetch: async () => calls++ === stoppedTurn ? refusal() : Response.json({ model: MODEL, content: [{ type: "text", text: tool({ tool: "wiki_search", query: "refund" }) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    const model = createGatewayAnswerModel(gateway, A);
    const result: unknown = await w.service({ model }).ask({ personId: "ada", project: "alpha", body: body() }).catch((caught: unknown) => caught);
    expect(result).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${PAUSED}` });
    expect(calls).toBe(stoppedTurn + 1);
    expect(w.logs.some(log => log["event"] === "answer.done")).toBe(false);
  });

  it("returns the person's answer slot when the install refuses before any model work", async () => {
    const w = world();
    w.roles.add(`${A}/alpha/ada`);
    let paused = true;
    const gateway = createHttpAnswersGateway({ gatewayUrl: "https://gateway.example", issuer: "https://issuer.example", model: MODEL,
      signer: taskKeySigner({ sign: async () => Buffer.from("test-signature"), publicJwk: async () => ({ kty: "RSA", kid: "test-signing-key", alg: "RS256", use: "sig", n: "test", e: "AQAB" }) }),
      runPrice: async () => ({ ...runPriceFor(MODEL), companyId: A, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }),
      fetch: async () => paused ? refusal() : Response.json({ model: MODEL, content: [{ type: "text", text: finalAnswer([goodSentence]) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    const service = w.service({ model: createGatewayAnswerModel(gateway, A), over: { perPersonPerHour: 1 } });
    await expect(service.ask({ personId: "ada", project: "alpha", body: body() })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    // Using an available source after the refusal must not be stopped by a slot that did no work.
    paused = false;
    expect(await service.ask({ personId: "ada", project: "alpha", body: body() })).toMatchObject({ outcome: "answered" });
  });

  it.each([[403, `${PAUSED} untrusted detail`], [500, PAUSED]])("does not echo an unrecognized gateway refusal (%s)", async (status, message) => {
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { fetch: async () => refusal(status, message), onUsage: () => undefined,
      proxy: { baseUrl: "https://gateway.example", apiKey: "task-token", route: { alias: MODEL, api: "anthropic-messages", catalog: MODEL } } });
    const result = await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context);
    expect(result.errorMessage).not.toBe(PAUSED);
    expect(result.errorMessage).not.toContain("untrusted detail");
  });

  it("own-key calls do not interpret a provider's matching sentence as an install setting", async () => {
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { environment: { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:222222222222:secret:test-key" }, readSecret: async () => "sk-ant-test-own-key-with-enough-characters", fetch: async () => refusal(), onUsage: () => undefined });
    const result = await runtime.completeSimple(runtime.getModel("anthropic", MODEL)!, context);
    expect(result.errorMessage).not.toBe(PAUSED);
    expect(failedTurn(result)).not.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });
});
