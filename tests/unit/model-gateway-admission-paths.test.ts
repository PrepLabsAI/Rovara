import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, caps, claims, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { DynamoReviewerGrants, InMemoryReviewerGrants } from "../../packages/model-gateway/src/reviewer-grants.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { productCall, productGateway, storeKit, admin, maintainer, PRODUCT_COMPANY_OWNER } from "./model-gateway-product-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import type { AgentAiSource } from "../../packages/model-gateway/src/agent-ai.js";
beforeAll(denyNetwork);
const alias = "claude-haiku-4-5", id = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const body = { ...requestBody, model: alias, stream: false };
const review = { mdl: [alias], stp: "second_review", exp: now / 1000 + 120, reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 1 } };
function meters(durable: boolean) {
  const a = { meter: "agent-meter", ledger: "agent-ledger", markers: "agent-markers" }, p = { meter: "product-meter", ledger: "product-ledger", markers: "product-markers" };
  const wire = new WireDynamo([...Object.values(a), ...Object.values(p)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const agent = durable ? new DynamoMeter({ db, tables: a, now: () => now }) : new InMemoryMeter(() => now);
  const product = durable ? new DynamoMeter({ db, tables: p, combinedCompany: { meter: a.meter, markers: a.markers }, now: () => now }) : new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent as InMemoryMeter });
  const grants = durable ? new DynamoReviewerGrants(db, a.markers, () => now) : new InMemoryReviewerGrants();
  return { agent, product, grants };
}
function agentWorld(durable: boolean, task = caps.task) {
  const m = meters(durable);
  let source: AgentAiSource = "bedrock_byo", revision = "r1", input = 2;
  const send = vi.fn(async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: input, output_tokens: 1 } })); })() }));
  const assumed = vi.fn(async () => ({ ok: true as const, credentials: { accessKeyId: "TEST", secretAccessKey: "not-real" } }));
  const w = setup({ meter: m.agent, chargeReceipts: { source: (_c, _m, resolved) => resolved }, reviewerGrants: m.grants, caps: new FixedCapsSource({ ...caps, task }), transport: send, agentKeys: { connected: async () => true, keyFor: async () => "fixture-key" } });
  w.deps.agentAi = { sources: { sourceFor: async () => source }, byo: { connection: async (iss, cid) => ({ row: { iss, cid, owner: "_company", sourceId: "own", versionId: revision }, connection: { scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: id }, allowGlobal: false } }), sessions: { credentials: assumed, forget: () => undefined }, transport: () => send } };
  return { ...w, ...m, send, assumed, select: (value: AgentAiSource) => { source = value; }, revise: () => { revision = "r2"; }, usage: (value: number) => { input = value; } };
}
async function productWorld(w: ReturnType<typeof agentWorld>, blocked?: Promise<void>, input = 2) {
  const kit = storeKit({ bedrockCheck: async (_cid, c) => ({ result: "ok", models: Object.fromEntries(Object.values(c.models).map(model => [model, "ready"])) }) });
  await kit.store.connect({ iss: claims.iss, cid: claims.cid, owner: PRODUCT_COMPANY_OWNER, requestId: crypto.randomUUID(), expectedRevision: 0, actor: admin, sourceId: "src_bedrock", provider: "bedrock", key: JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: id }, allowGlobal: false }) });
  await kit.store.link({ iss: claims.iss, cid: claims.cid, owner: claims.pid, requestId: crypto.randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_link", companySourceId: "src_bedrock" });
  const send = vi.fn(async () => { await blocked; return { status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: input, outputTokens: 1, totalTokens: input + 1 } })); })() }; });
  const g = await productGateway({ kit, connect: false, productMeter: w.product, overrides: { meter: w.agent, chargeReceipts: { source: (_c, _m, resolved) => resolved } }, bedrock: { sessions: { credentials: w.assumed, forget: () => undefined }, transport: () => send } });
  return { ...g, send, invoke: (tid: string, headers: Record<string, string> = {}) => productCall(g.deps, `/v1/product/bedrock/model/${encodeURIComponent(id)}/converse`, { messages: [{ role: "user", content: [{ text: "hello" }] }], inferenceConfig: { maxTokens: 10 } }, mint({ mdl: [alias], tid }), headers) };
}
for (const durable of [false, true]) {
  it(`agent overage stops agents while real product calls continue (${durable})`, async () => {
    const w = agentWorld(durable); w.usage(100_000);
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    const g = await productWorld(w); w.assumed.mockClear();
    expect((await g.invoke("task_product")).status).toBe(200);
    expect(w.assumed).toHaveBeenCalledTimes(1); expect(g.send).toHaveBeenCalledTimes(1);
    expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_blocked" }))).status).toBe(422);
    expect(w.send).toHaveBeenCalledTimes(1);
  });
  it(`product overage stops products while real agent calls continue (${durable})`, async () => {
    const w = agentWorld(durable), g = await productWorld(w, undefined, 100_000);
    const reserve = vi.spyOn(w.product, "reserve");
    expect((await g.invoke("task_product_over")).status).toBe(200);
    expect(reserve.mock.calls[0]?.[0]).toMatchObject({ customerSource: "bedrock_byo", routeClass: "product" });
    expect((await w.product.read(reserve.mock.calls[0]![0].scope)).every(row => row.spentMicros === 100002)).toBe(true);
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    expect((await g.invoke("task_product_blocked")).status).toBe(422);
    expect(g.send).toHaveBeenCalledTimes(1); expect(w.send).toHaveBeenCalledTimes(1);
  });
  it(`S1 four real product calls cannot bypass a live agent source slot (${durable})`, async () => {
    const w = agentWorld(durable); const h = await w.agent.reserve({ scope, caps, estimateMicros: 10, customerSource: "bedrock_byo", routeClass: "agent" });
    expect(h.ok).toBe(true);
    const g = await productWorld(w); w.assumed.mockClear();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => g.invoke(`task_product_${i}`)));
    expect(results.map(result => result.status)).toEqual([429, 429, 429, 429]);
    expect(w.assumed).not.toHaveBeenCalled(); expect(g.send).not.toHaveBeenCalled();
    expect((await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo"))?.inFlight).toBe(h.ok ? h.reservation.id : "");
  });
  it(`S1 product hold owns the shared slot and settles one external-provider receipt (${durable})`, async () => {
    const w = agentWorld(durable); let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const g = await productWorld(w, barrier); const settled = vi.spyOn(w.product, "settleV2"), reserve = vi.spyOn(w.product, "reserve");
    const pending = g.invoke("task_product");
    try {
      await vi.waitFor(() => expect(g.send).toHaveBeenCalledTimes(1));
      expect(reserve.mock.calls[0]![0]).toMatchObject({ customerSource: "bedrock_byo", routeClass: "product", charge: { receipt: { billing: "external_provider", source: { id: "src_bedrock", provider: "bedrock" } } } });
      expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(429);
    } finally { release(); }
    expect((await pending).status).toBe(200);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0].receipt).toMatchObject({ billing: "external_provider", source: { kind: "company_key", id: "src_bedrock", provider: "bedrock" }, amountMicros: { value: 4 }, billableMicros: { value: 0 } });
    expect((await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo"))?.inFlight).toBeUndefined();
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
  });
  it(`S2 Bedrock-to-Anthropic review switch takes a new hold and enforces the task cap (${durable})`, async () => {
    const w = agentWorld(durable, 1000), token = mint(review);
    expect((await call(w.deps, body, token)).status).toBe(200);
    expect((await w.agent.read(scope)).find(row => row.item === "task")).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
    w.select("anthropic_key"); w.usage(1000);
    const bigger = { ...body, messages: [{ role: "user", content: "x".repeat(3000) }] };
    expect((await call(w.deps, bigger, mint({ mdl: [alias] }))).status).toBe(422);
    const reserve = vi.spyOn(w.agent, "reserve");
    expect((await call(w.deps, bigger, token)).status).toBe(422);
    expect(reserve).toHaveBeenCalledTimes(1); expect(w.send).toHaveBeenCalledTimes(1);
    expect((await w.agent.read(scope)).find(row => row.item === "task")).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
  });
  for (const change of ["accounting", "source", "reverse"] as const) it(`S2 incompatible review ${change} binding refuses reuse and settles each new hold once (${durable})`, async () => {
    const w = agentWorld(durable), token = mint(review);
    if (change === "reverse") w.select("anthropic_key");
    const settled = vi.spyOn(w.agent, "settle"), receipts = vi.spyOn(w.agent, "settleV2");
    expect((await call(w.deps, body, token)).status).toBe(200);
    const oldSession = await w.grants.read(claims.iss, claims.cid, claims.jti);
    if (change === "accounting") w.select("anthropic_key"); else if (change === "reverse") w.select("bedrock_byo"); else w.revise();
    const reserve = vi.spyOn(w.agent, "reserve");
    expect((await call(w.deps, body, token)).status).toBe(401);
    expect(reserve).toHaveBeenCalledTimes(1); expect(w.send).toHaveBeenCalledTimes(1);
    expect(await w.grants.read(claims.iss, claims.cid, claims.jti)).toEqual(oldSession);
    expect(receipts).toHaveBeenCalledTimes(change === "accounting" ? 1 : change === "reverse" ? 1 : 2);
    // InMemory settleV2 delegates to settle; Dynamo settles its receipt in one transaction.
    const receiptCount = change === "source" ? 2 : 1;
    expect(settled).toHaveBeenCalledTimes((durable ? 0 : receiptCount) + (change === "accounting" ? 1 : 0));
    expect(new Set(receipts.mock.calls.map(([input]) => input.reservationId)).size).toBe(receiptCount);
    expect(new Set(settled.mock.calls.map(([hold]) => hold.id)).size).toBe(settled.mock.calls.length);
    if (change !== "reverse") expect((await w.agent.read(scope)).find(row => row.item === "task")).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
  });
  it(`S2 stable Bedrock review reuse settles two distinct holds exactly once (${durable})`, async () => {
    const w = agentWorld(durable), token = mint(review), receipts = vi.spyOn(w.agent, "settleV2");
    expect((await call(w.deps, body, token)).status).toBe(200);
    expect((await call(w.deps, body, token)).status).toBe(200);
    expect(new Set(receipts.mock.calls.map(([input]) => input.reservationId)).size).toBe(2);
    expect(receipts).toHaveBeenCalledTimes(2);
    expect((await w.agent.read(scope)).find(row => row.item === "task")).toMatchObject({ spentMicros: 8, reservedMicros: 0 });
  });
}
for (const kind of ["image", "document"] as const) it(`S3 signed unsafe Bedrock ${kind} review returns reviewer 422 before hold/claim/STS/send`, async () => {
  const w = agentWorld(false);
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload(); w.deps.prices = prices;
  const quote = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources: w.deps.agentAi!.sources, keys: w.deps.agentKeys!, byo: w.deps.agentAi!.byo!, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${alias}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const runPrice = (quote.body as { runPrice: RunPrice }).runPrice; expect(runPrice).toBeDefined();
  const reserve = vi.spyOn(w.agent, "reserve"), open = vi.spyOn(w.grants, "open");
  const result = await call(w.deps, { ...body, messages: [{ role: "user", content: [{ type: kind, source: { type: "base64", media_type: kind === "image" ? "image/png" : "application/pdf", data: "AAAA" } }] }] }, mint({ ...review, runPrice }));
  expect(result.status).toBe(422); expect(JSON.parse(result.text())).toEqual({ error: { type: "budget_exceeded", message: "Budget has been exceeded! Key=reviewer" } });
  expect(reserve).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(w.assumed).not.toHaveBeenCalled(); expect(w.send).not.toHaveBeenCalled();
  expect((await call(w.deps, body, mint({ ...review, runPrice: { ...runPrice, snapshotHash: "a".repeat(64) } }))).status).toBe(409);
});
