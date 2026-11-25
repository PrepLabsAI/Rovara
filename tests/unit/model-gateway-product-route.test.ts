import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { PRODUCT_KEY_REFUSED, PRODUCT_NOT_SET_UP, PRODUCT_OVER_BY_ONE_CALL, productModelLimitsFrom, createProductCaps } from "../../packages/model-gateway/src/product-route.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { call, mint, scope as agentScope } from "./model-gateway-fixture.js";
import { cid, iss, change, geminiAnswer, geminiBody, geminiSse, maintainer, pid, productCall, productGateway, productScope, streamPath, wholePath } from "./model-gateway-product-fixture.js";

describe("product route: the Gemini journey", () => {
  it("streams while held, settles usage x the resolver's price to the project, and touches only the agent meter's company row (DEC 228c)", async () => {
    let release!: () => void; let opened!: () => void;
    const pause = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { opened = r; });
    const g = await productGateway({ transport: async () => ({ status: 200, body: (async function* () {
      yield Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }] } }] })}\r\n\r\n`); opened(); await pause;
      yield Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 1 } })}\r\n\r\n`);
    })() }) });
    const running = productCall(g.deps); await started;
    const held = await g.productMeter.read(productScope);
    expect(held[0]!.reservedMicros).toBeGreaterThan(0); expect(held[0]!.spentMicros).toBe(0);
    release(); const sink = await running;
    expect(sink.status).toBe(200); expect(sink.headers["content-type"]).toContain("text/event-stream"); expect(sink.text()).toContain("finishReason");
    // 10 input x $1/M + (4 answer + 1 thinking) x $2/M = 20 micros.
    const rows = await g.productMeter.read(productScope);
    expect(rows.map((r) => r.item)).toEqual(["task", "project", "company"]);
    expect(rows.every((r) => r.spentMicros === 20 && r.reservedMicros === 0)).toBe(true);
    const agentRows = await g.meter.read(agentScope);
    expect(agentRows.filter((r) => r.item !== "company").every((r) => r.spentMicros === 0 && r.reservedMicros === 0)).toBe(true);
    // One combined company monthly cap: the product call's spend is on the agent meter's company row too.
    expect(agentRows.find((r) => r.item === "company")).toMatchObject({ spentMicros: 20, reservedMicros: 0 });
    expect(g.logs).toContainEqual({ event: "settled", costMicros: 20, estimated: false, appliedMaxOutputTokens: 100, route: "product" });
  });
  it("forwards to the checked upstream path with the project key, sets maxOutputTokens, and strips every worker credential", async () => {
    const g = await productGateway({ transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })); })() }) });
    expect((await productCall(g.deps, wholePath, { contents: [{ parts: [{ text: "x" }] }] })).status).toBe(200);
    const sent = g.productCalls[0]!;
    expect(sent.key).toBe(g.key); expect(sent.path).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect((JSON.parse(Buffer.from(sent.body).toString()) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(8192);
    expect(Object.keys(sent.headers)).toEqual(["content-type"]);
    expect(JSON.stringify(sent.headers)).not.toContain(mint().slice(0, 20));
  });
  it("whole (non-streamed) answers settle from usageMetadata", async () => {
    const g = await productGateway({ transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 6, cachedContentTokenCount: 2, candidatesTokenCount: 3 } })); })() }) });
    expect((await productCall(g.deps, wholePath)).status).toBe(200);
    // 4 input x 1 + 2 cache-read at the input rate (no cache price known) x 1 + 3 x 2 = 12.
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(12);
  });
  it("is settled to the project: no person item even when the token names a person", async () => {
    const g = await productGateway();
    await productCall(g.deps);
    expect((await g.productMeter.read({ ...productScope, per: "a".repeat(64) })).find((r) => r.item === "person")!.spentMicros).toBe(0);
  });
  it("uses the project's product caps, refuses the next call over the task cap without sending", async () => {
    const g = await productGateway();
    await g.kit.store.setCaps({ ...change(pid, 1, maintainer), caps: { taskMicros: 300, projectMonthMicros: 1_000_000 } });
    expect((await productCall(g.deps)).status).toBe(200);
    const refused = await productCall(g.deps, streamPath, { ...geminiBody, generationConfig: { maxOutputTokens: 200 } });
    expect(refused.status).toBe(422); expect(refused.text()).toContain("Product AI budget has been exceeded! Key=task");
    expect(g.productCalls).toHaveLength(1);
  });
  it("an unknown Gemini model price holds the cautious estimate, settles above zero and is flagged estimated (DEC 172/216)", async () => {
    const g = await productGateway({ overrides: { prices: { priceFor: () => undefined } } });
    expect((await productCall(g.deps)).status).toBe(200);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBeGreaterThan(0);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true, route: "product" }));
    const pending = await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5);
    expect(pending.items).toHaveLength(1); expect(pending.items[0]!.settledMicros).toBeGreaterThan(0);
  });
  it("a project with no product source answers the fixed not-set-up words and holds nothing", async () => {
    const g = await productGateway({ connect: false });
    const sink = await productCall(g.deps);
    expect(sink.status).toBe(404); expect(sink.text()).toContain(PRODUCT_NOT_SET_UP); expect(g.productCalls).toHaveLength(0);
    expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
  });
  it("a provider 401/403 is not charged, says the fixed key-refused words and marks the source for Settings", async () => {
    for (const status of [401, 403]) {
      const g = await productGateway({ transport: async () => ({ status, body: (async function* () { yield Buffer.from(`{"error":{"message":"API key ${"z".repeat(10)} not valid"}}`); })() }) });
      const sink = await productCall(g.deps);
      expect(sink.status).toBe(502); expect(sink.text()).toContain(PRODUCT_KEY_REFUSED); expect(sink.text()).not.toContain("API key");
      expect((await g.productMeter.read(productScope))[0]).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      await new Promise((r) => setTimeout(r, 0));
      expect((await g.kit.store.view(iss, cid, pid)).sources[0]!.warning?.status).toBe(status);
    }
  });
  it("400/404/429 are not charged; a 5xx after send is charged in full", async () => {
    for (const [status, charged] of [[400, false], [404, false], [429, false], [500, true], [503, true]] as const) {
      const g = await productGateway({ transport: async () => ({ status, body: (async function* () { /* empty */ })() }) });
      await productCall(g.deps);
      const spent = (await g.productMeter.read(productScope))[0]!.spentMicros;
      expect(charged ? spent > 0 : spent === 0).toBe(true);
    }
  });
  it("DEC 165: a settle above its hold blocks every further product call in the task with 'budget exceeded by one call'", async () => {
    // The usage is far above the hold of a 1-token answer: the call is over by one, the next is refused before sending.
    const g = await productGateway({ transport: async () => ({ status: 200, body: geminiAnswer({ promptTokenCount: 10, candidatesTokenCount: 90_000 }) }) });
    expect((await productCall(g.deps, streamPath, { ...geminiBody, generationConfig: { maxOutputTokens: 1 } })).status).toBe(200);
    expect(g.logs).toContainEqual({ event: "product_over_reservation" });
    const next = await productCall(g.deps);
    expect(next.status).toBe(422); expect(next.text()).toContain(PRODUCT_OVER_BY_ONE_CALL); expect(g.productCalls).toHaveLength(1);
    // Another task of the same project is not blocked.
    expect((await productCall(g.deps, streamPath, geminiBody, mint({ tid: "task_2" }))).status).toBe(200);
  });
  it("the agent route is unchanged next to it", async () => {
    const g = await productGateway();
    expect((await call(g.deps)).status).toBe(200);
    expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
  });
  it("without a product resolver every product path is 404, as before (feature off)", async () => {
    const g = await productGateway();
    const { product: _product, ...withoutProduct } = g.deps; void _product;
    for (const path of [streamPath, wholePath]) expect((await productCall(withoutProduct, path)).status).toBe(404);
  });
  it("malformed or incomplete Gemini streams fall back to the full hold, never a partial cost", async () => {
    for (const body of [geminiSse([{ candidates: [{ content: { parts: [{ text: "no finish" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]), geminiSse([{ error: { code: 500 } }])]) {
      const g = await productGateway({ transport: async () => ({ status: 200, body }) });
      await productCall(g.deps);
      expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBeGreaterThan(20);
    }
  });
  it("not-sent faults cost nothing; faults after send are charged in full", async () => {
    for (const notSent of [true, false]) {
      const g = await productGateway({ transport: async () => { throw notSent ? new NotSentError() : new Error("socket reset with secret text"); } });
      const sink = await productCall(g.deps);
      expect(sink.status).toBe(502); expect(sink.text()).not.toContain("secret");
      const spent = (await g.productMeter.read(productScope))[0]!.spentMicros; expect(notSent ? spent === 0 : spent > 0).toBe(true);
    }
  });
  it("#53: a company with no monthly cap (or an unreadable budget row) gets no product calls: 503, nothing held or sent", async () => {
    for (const companyCaps of [{ capsFor: async () => ({}) as never }, { capsFor: async () => ({ task: 1, projectMonth: 1 }) }, { capsFor: async () => ({ task: 1, projectMonth: 1, companyMonth: 1_000_000, unexpected: 1 }) as never }, { capsFor: async () => ({ task: -1, projectMonth: 1, companyMonth: 1_000_000 }) }, { capsFor: async () => { throw new Error("table down"); } }]) {
      const g = await productGateway({ companyCaps });
      const sink = await productCall(g.deps);
      expect([502, 503]).toContain(sink.status); expect(g.productCalls).toHaveLength(0);
      expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
    }
  });
  it("#53: the company backend's monthly cap bounds the product meter's company row, together with the product ceiling", async () => {
    const g = await productGateway({ companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 300 }) });
    expect((await productCall(g.deps)).status).toBe(200);
    const refused = await productCall(g.deps, streamPath, { ...geminiBody, generationConfig: { maxOutputTokens: 200 } });
    expect(refused.status).toBe(422); expect(refused.text()).toContain("Team=company");
    const companyCaps = await createProductCaps(g.kit.store, new FixedCapsSource({ task: 9, projectMonth: 9, companyMonth: 500 })).capsFor(productScope);
    expect(companyCaps.companyMonth).toBe(500);
    await g.kit.store.setCeiling({ ...change("_company", 0), ceiling: { companyMonthMicros: 300 } });
    expect((await createProductCaps(g.kit.store, new FixedCapsSource({ task: 9, projectMonth: 9, companyMonth: 500 })).capsFor(productScope)).companyMonth).toBe(300);
  });
  it("#53: per-model output ceilings come from the price rows for Gemini; a model with no row uses the default", async () => {
    const rows = { maxOutputTokens: (provider: string, model: string) => provider === "gemini" && model === "gemini-2.5-flash" ? 4096 : undefined };
    const limits = productModelLimitsFrom(rows);
    expect(limits.maxOutputTokens("gemini", "gemini-2.5-flash")).toBe(4096);
    expect(limits.maxOutputTokens("anthropic", "gemini-2.5-flash")).toBeUndefined();
    const g = await productGateway({ modelLimits: limits, transport: async () => ({ status: 200, body: geminiAnswer() }) });
    expect((await productCall(g.deps, streamPath, { contents: geminiBody.contents })).status).toBe(200);
    expect((JSON.parse(Buffer.from(g.productCalls[0]!.body).toString()) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(4096);
    expect((await productCall(g.deps, streamPath, { ...geminiBody, generationConfig: { maxOutputTokens: 4097 } })).status).toBe(400);
    const other = await productGateway({ modelLimits: limits, transport: async () => ({ status: 200, body: geminiAnswer() }) });
    expect((await productCall(other.deps, "/v1/product/gemini/v1beta/models/gemini-9-new:streamGenerateContent?alt=sse", { contents: geminiBody.contents })).status).toBe(200);
    expect((JSON.parse(Buffer.from(other.productCalls[0]!.body).toString()) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(65_536);
  });
});
