// Fix with agent's model call, through the REAL local model proxy and callback listener (a fake provider on a real socket): the call is the owner's own key signing it in the proxy and never anywhere else, the request passes
// the proxy's guard (no tools, nothing kept at the provider), the route is held to the diagnosis's spending cap before a key is read, a model with no known price is not used, what a call used is metered, the answer never
// holds the key, and the one-shot token and operation die with the call. A worker's capability can never name a diagnosis's operation.
import { afterEach, describe, expect, it } from "vitest";
import { DIAGNOSIS_LIGHT_BUDGET_USD } from "@agentx/contracts";
import type { DiagnosisModelProblem } from "../../packages/broker/src/core/diagnosis/index.js";
import { createLocalDiagnosisModel, modelRatesOf, reasonOfAnswer, type LocalDiagnosisModelOptions } from "../../packages/broker/src/local/diagnosis-model.js";
import { MODEL_PROXY_PREFIX, OneShotOperations, WORKSPACE_HEADER, builtinModelProviderBook, localRoute } from "../../packages/broker/src/local/model-proxy/index.js";
import { askForToken, startModelProxyWorld, type ModelProxyWorld } from "../support/model-proxy-world.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });

const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CHOICE = { provider: "anthropic", model: "claude-test" } as const;

async function world(overrides: Partial<LocalDiagnosisModelOptions> = {}) {
  const operations = new OneShotOperations();
  const w = await startModelProxyWorld({ oneShot: operations });
  open.push(() => w.close());
  const model = createLocalDiagnosisModel({
    choice: async () => CHOICE, providers: builtinModelProviderBook(), proxy: () => ({ tokens: w.proxy.tokens, port: w.callback.tcpPort }), operations, rates: () => RATES, ...overrides,
  });
  const input = (over: Partial<Parameters<typeof model.answer>[0]> = {}) => ({
    context: "The rules, then the data.", question: "Diagnose the error.", maxOutputTokens: 1_000, signal: AbortSignal.timeout(10_000), diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa", taskId: "task-9", project: "web", ...over,
  });
  return { w, model, operations, input };
}

const keyIn = (w: ModelProxyWorld): string => w.keys.anthropic;
const everythingVisible = (w: ModelProxyWorld, ...extra: unknown[]): string => JSON.stringify([w.events, w.metered, extra, w.provider.calls.map((call) => call.body)]);

describe("a diagnosis's model call", () => {
  it("is made through the proxy with the owner's key where the provider expects it, with no tools and nothing stored, metered, and the key is nowhere else", async () => {
    const { w, model, input } = await world();
    w.provider.text = "The planning step failed.";
    const answer = await model.answer(input());
    expect(answer).toMatchObject({ text: "The planning step failed.", model: "anthropic/claude-test", usage: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 400 } });
    expect(w.provider.calls).toHaveLength(1);
    const call = w.provider.calls[0]!;
    expect(call.path).toBe("/v1/messages");
    expect(call.headers["x-api-key"]).toBe(keyIn(w));
    expect(call.body).toMatchObject({ model: "claude-test", max_tokens: 1_000, stream: false, system: "The rules, then the data.", messages: [{ role: "user", content: "Diagnose the error." }] });
    expect(call.body["tools"]).toBeUndefined();
    // The call was metered by the proxy, in the owner's company, against the task and project it was for.
    expect(w.metered).toHaveLength(1);
    expect(w.metered[0]!.entry).toMatchObject({ taskId: "task-9", projectName: "web", usage: { provider: "anthropic", modelId: "claude-test", tokens: { input: 1_000, output: 200 } } });
    expect(w.metered[0]!.result.cost).not.toBeNull();
    // The key is in what the provider was sent as its header and in nothing the caller, the events or the meter hold.
    expect(JSON.stringify([answer, w.events, w.metered])).not.toContain(keyIn(w));
    expect(JSON.stringify(w.provider.calls.map((entry) => entry.body))).not.toContain(keyIn(w));
  });

  it("is held to the diagnosis's spending cap before any key is read: a call that could cost more is refused and the provider is never called", async () => {
    expect(DIAGNOSIS_LIGHT_BUDGET_USD).toBe(0.25);
    const { w, model, input } = await world({ capUsd: 0.01 });
    await expect(model.answer(input({ maxOutputTokens: 4_000 }))).rejects.toMatchObject({ reason: "limit_reached" });
    expect(w.provider.calls).toHaveLength(0);
    expect(w.metered).toHaveLength(0);
    // A smaller call under the same cap goes through: the cap is on what a call could cost, not a switch.
    const small = await model.answer(input({ maxOutputTokens: 50, context: "short" }));
    expect(small.text).toBe("hello");
    // The worst case of a request is an input of one token to each byte: a large context under a small model cap is refused for its size.
    await expect(model.answer(input({ maxOutputTokens: 50, context: "x".repeat(60_000) }))).rejects.toMatchObject({ reason: "limit_reached" });
    expect(w.provider.calls).toHaveLength(1);
  });

  it("is not made on a model whose price is not known: nothing is offered, and a call that is forced is refused before the proxy", async () => {
    const { w, model, input } = await world({ rates: () => undefined });
    expect(await model.prepare()).toEqual({ ok: false, reason: "not_priced" });
    await expect(model.answer(input())).rejects.toMatchObject({ reason: "not_priced", sent: false });
    expect(w.provider.calls).toHaveLength(0);
    // A price of zero is no price, unless the plug-in says the model is free; the catalog's and a plug-in's rows are both read.
    expect(modelRatesOf("anthropic", "model-nobody-listed", builtinModelProviderBook().get("anthropic"))).toBeUndefined();
    const priced = { prices: { currency: "USD", models: { "m-1": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 }, "m-0": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, "m-free": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, free: true } } } };
    const row = { ...builtinModelProviderBook().get("anthropic")!, ...priced } as unknown as Parameters<typeof modelRatesOf>[2];
    expect(modelRatesOf("anthropic", "m-1", row)).toEqual({ input: 1, output: 4, cacheRead: 1, cacheWrite: 1 });
    expect(modelRatesOf("anthropic", "m-0", row)).toBeUndefined();
    // A model the plug-in declares free is priced, at zero: it is the plug-in's word that it costs nothing (a model with no word says nothing, and is refused).
    expect(modelRatesOf("anthropic", "m-free", row)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // A table in another currency is never read as dollars.
    const pounds = { ...row, prices: { ...(row as unknown as { prices: object }).prices, currency: "GBP" } } as unknown as Parameters<typeof modelRatesOf>[2];
    expect(modelRatesOf("anthropic", "m-1", pounds)).toBeUndefined();
    expect(modelRatesOf("anthropic", "m-free", pounds)).toBeUndefined();
    // A catalog row priced at zero is no price either (a free model is the plug-in's to declare, not the catalog's).
    const zero = { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 };
    expect(modelRatesOf("anthropic", "listed", undefined, () => zero)).toBeUndefined();
    expect(modelRatesOf("anthropic", "listed", undefined, () => ({ ...zero, input: 3, output: 0 }))).toBeUndefined();
    // (A cache price the catalog does not list counts at the input price: the shared price lookup never under-counts it.)
    expect(modelRatesOf("anthropic", "listed", undefined, () => ({ ...zero, input: 3 }))).toEqual({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
    // A cap never assumes less than the catalog's list price (a slip in a plug-in's table must not make a paid model cheap), and a plug-in that is dearer than the catalog is believed.
    expect(modelRatesOf("anthropic", "m-1", row, () => ({ input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }))).toEqual({ input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
    expect(modelRatesOf("anthropic", "m-1", row, () => ({ input: 0.5, output: 2, cacheRead: 0.5, cacheWrite: 0.5 }))).toEqual({ input: 1, output: 4, cacheRead: 1, cacheWrite: 1 });
    // A proxy refusal that says the model has no price is a refusal made before the call was sent, and reads as "not priced".
    expect(reasonOfAnswer(403, JSON.stringify({ type: "error", error: { type: "model_not_priced", code: "model_not_priced", message: "this model has no price on this computer" } }))).toMatchObject({ reason: "not_priced", beforeSend: true });
  });

  it("is not offered when the most this call could cost, for this much data, is over the cap, and is the same worst case the proxy holds it to", async () => {
    const { w, model, input } = await world({ capUsd: 0.05 });
    const small = { context: "short", question: "Diagnose the error.", maxOutputTokens: 500 };
    expect(await model.prepare(small)).toEqual({ ok: true });
    expect(await model.prepare()).toEqual({ ok: true });
    // 4,000 tokens out at 15 dollars a million is 0.06: over a 0.05 cap whatever the context is; and a large context alone is too.
    expect(await model.prepare({ ...small, maxOutputTokens: 4_000 })).toEqual({ ok: false, reason: "too_dear" });
    expect(await model.prepare({ ...small, context: "x".repeat(60_000) })).toEqual({ ok: false, reason: "too_dear" });
    // What it says fits goes through the proxy; what it says does not fit is exactly what the proxy refuses.
    await expect(model.answer(input({ ...small, context: "x".repeat(60_000), maxOutputTokens: 500 }))).rejects.toMatchObject({ reason: "limit_reached", sent: false });
    expect((await model.answer(input({ maxOutputTokens: 500, context: "short" }))).text).toBe("hello");
    expect(w.provider.calls).toHaveLength(1);
    // The dear cases are those the proxy refuses at the limit's edge: one byte of context under the line is allowed, one over is not (the rule is the proxy's: one token to each byte of the request).
    let low = 0, high = 60_000;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if ((await model.prepare({ ...small, context: "x".repeat(mid) })).ok) low = mid; else high = mid;
    }
    expect((await model.prepare({ ...small, context: "x".repeat(low) })).ok).toBe(true);
    await expect(model.answer(input({ maxOutputTokens: 500, context: "x".repeat(high) }))).rejects.toMatchObject({ reason: "limit_reached" });
    expect((await model.answer(input({ maxOutputTokens: 500, context: "x".repeat(low) }))).text).toBe("hello");
  });

  it("is not offered with no model chosen or no key on this computer, and says so as a fixed word", async () => {
    const none = await world({ choice: async () => undefined });
    expect(await none.model.prepare()).toEqual({ ok: false, reason: "no_model" });
    await expect(none.model.answer(none.input())).rejects.toMatchObject({ reason: "no_model", sent: false });
    const noProxy = await world({ proxy: () => undefined });
    expect(await noProxy.model.prepare()).toEqual({ ok: false, reason: "no_model" });
    await expect(noProxy.model.answer(noProxy.input())).rejects.toMatchObject({ reason: "no_model", sent: false });
    // The model is chosen but its key is gone: the proxy says no key, and the word is the key's.
    const { w, model, input } = await world();
    w.keyStore.remove("anthropic");
    await expect(model.answer(input())).rejects.toMatchObject({ reason: "key_invalid", sent: false });
    expect(w.provider.calls).toHaveLength(0);
  });

  it("reads a provider that refuses the key, is down or answers with the key in it as a fixed word, and never repeats the provider's words", async () => {
    const { w, model, input } = await world();
    const failure = async (): Promise<DiagnosisModelProblem> => {
      try { await model.answer(input()); } catch (error) { return error as DiagnosisModelProblem; }
      throw new Error("the call should have failed");
    };
    w.provider.mode = "unauthorized-echo";
    const refused = await failure();
    // Every one of these follows the send (the provider answered, or the proxy's copy of its answer failed): the allowance is settled, so none is "not sent".
    expect(refused).toMatchObject({ name: "DiagnosisModelProblem", reason: "key_invalid", message: "key_invalid", sent: true });
    w.provider.mode = "server-error";
    expect(await failure()).toMatchObject({ reason: "provider_unavailable", sent: true });
    w.provider.mode = "rate-limit";
    expect(await failure()).toMatchObject({ reason: "provider_unavailable", sent: true });
    w.provider.mode = "echo-key-whole";
    const leaky = await failure();
    expect(leaky).toMatchObject({ reason: "provider_unavailable", sent: true });
    expect(everythingVisible(w, refused.message, leaky.message, String(refused.stack), String(leaky.stack))).not.toContain(keyIn(w));
    w.provider.mode = "ok";
    expect((await model.answer(input())).text).toBe("hello");
  });

  it("mints a token that lives minutes, not hours: five at most, whatever the call does", async () => {
    const operations = new OneShotOperations();
    const w = await startModelProxyWorld({ oneShot: operations });
    open.push(() => w.close());
    const lives: number[] = [];
    const tokens = { mint: (grant: Parameters<typeof w.proxy.tokens.mint>[0], options?: Parameters<typeof w.proxy.tokens.mint>[1]) => { const minted = w.proxy.tokens.mint(grant, options); lives.push(minted.expiresAt - Date.now()); return minted; }, forgetOperation: (id: string) => w.proxy.tokens.forgetOperation(id) };
    const model = createLocalDiagnosisModel({ choice: async () => CHOICE, providers: builtinModelProviderBook(), proxy: () => ({ tokens, port: w.callback.tcpPort }), operations, rates: () => RATES });
    await model.answer({ context: "c", question: "q", maxOutputTokens: 100, signal: AbortSignal.timeout(10_000), diagnosisId: "dgn_bbbbbbbbbbbbbbbbbbbb", taskId: "t", project: "web" });
    expect(lives).toHaveLength(1);
    expect(lives[0]!).toBeGreaterThan(60_000);
    expect(lives[0]!).toBeLessThanOrEqual(5 * 60_000);
  });

  it("counts a call as sent when the proxy fails after the provider answered: a cut connection and an answer too large are charged by the proxy, so the allowance must be settled", async () => {
    const { w, model, input } = await world();
    for (const mode of ["cut", "flood"] as const) {
      w.provider.mode = mode;
      const before = w.metered.length;
      const failed = await model.answer(input()).then(() => undefined, (error: unknown) => error as DiagnosisModelProblem);
      expect(failed, mode).toMatchObject({ name: "DiagnosisModelProblem", sent: true });
      // The provider was called and the proxy charged the worst case to the meter: the money is spent, whatever the answer was.
      expect(w.provider.calls.length, mode).toBeGreaterThan(0);
      expect(w.metered.length, mode).toBeGreaterThan(before);
    }
  }, 60_000);

  it("counts a call as sent when the provider cannot be reached: the request was already on its way", async () => {
    const { w, model, input } = await world();
    await w.provider.close();
    const failed = await model.answer(input()).then(() => undefined, (error: unknown) => error as DiagnosisModelProblem);
    expect(failed).toMatchObject({ reason: "provider_unavailable", sent: true });
  });

  it("gives the call a one-shot operation and token of its own that end with it, which a worker's capability cannot name or reuse", async () => {
    const { w, model, operations, input } = await world();
    await model.answer(input());
    expect(w.proxy.tokens.liveTokens()).toBe(0);
    expect(w.proxy.tokens.ledgerCount()).toBe(0);
    expect(operations.has({ workspaceId: "diagnosis-dgn_aaaaaaaaaaaaaaaaaaaa", operationId: "diagnosis:dgn_aaaaaaaaaaaaaaaaaaaa" })).toBe(false);
    // A token minted for it is good only while the operation runs: the proxy asks before every call.
    const route = { ...localRoute("anthropic", "claude-test").route };
    const minted = w.proxy.tokens.mint({ workspaceId: "diagnosis-late", operationId: "diagnosis:late", routes: [route] });
    const body = { model: route.alias, max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] };
    const late = await w.send({ path: `${MODEL_PROXY_PREFIX}/v1/messages`, headers: { "x-api-key": minted.token, [WORKSPACE_HEADER]: "diagnosis-late" }, body });
    expect(late.status).toBe(403);
    expect(JSON.parse(late.text)).toMatchObject({ error: { code: "operation_ended" } });
    // Only the earlier answer reached the provider.
    expect(w.provider.calls).toHaveLength(1);
    // The operation is the call's own and so is its workspace: the right operation under another workspace is not live (the proxy also refuses the stamp, but the registry must not say yes).
    operations.begin("diagnosis:mine", "diagnosis-mine");
    expect(operations.has({ operationId: "diagnosis:mine", workspaceId: "diagnosis-mine" })).toBe(true);
    expect(operations.has({ operationId: "diagnosis:mine", workspaceId: "diagnosis-other" })).toBe(false);
    expect(operations.has({ operationId: "diagnosis:other", workspaceId: "diagnosis-mine" })).toBe(false);
    const mine = w.proxy.tokens.mint({ workspaceId: "diagnosis-other", operationId: "diagnosis:mine", routes: [route] });
    const wrongWorkspace = await w.send({ path: `${MODEL_PROXY_PREFIX}/v1/messages`, headers: { "x-api-key": mine.token, [WORKSPACE_HEADER]: "diagnosis-other" }, body });
    expect(wrongWorkspace.status).toBe(403);
    expect(JSON.parse(wrongWorkspace.text)).toMatchObject({ error: { code: "operation_ended" } });
    operations.end("diagnosis:mine");
    // A worker's capability for such an operation is refused: the one-shot operation holds no workspace the task flow knows.
    operations.begin("diagnosis:forged", "diagnosis-forged");
    const asked = await askForToken(w, w.capability({ operationId: "diagnosis:forged", workspaceId: "diagnosis-forged" }), "diagnosis-forged");
    expect(asked.status).toBe(409);
    expect(w.proxy.tokens.liveTokens()).toBe(0);
  });
});
