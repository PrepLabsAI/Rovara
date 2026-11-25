// Opus money review (OpenRouter cache-write rule, DEC 254zzz442): the cases the lane's own G5 grid does not cover.
// R1: a STREAM whose write is reported ONLY in the final usage-only chunk (choices: []), after the content already reached the client (real OpenRouter chunk shape).
// R2: a later usage chunk that omits the write cannot erase it (write tokens and the cost-part marker).
// R3: two gateway instances on one durable meter: the latch written by instance A refuses the route on instance B (multi-instance).
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } from "../../packages/model-gateway/src/openrouter-policy.js";
beforeAll(denyNetwork);

const MODEL = "vendor/no-write-review"; // NOT on the relaxed list
const tariff = { model: MODEL, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", request: "0", input_cache_read: "0.0000005", input_cache_write: "0" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture", cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION };
const head = { id: "gen-review-1", provider: "Fixture", model: MODEL, object: "chat.completion.chunk", created: 1_763_900_000 };
const sse = (chunk: unknown) => Buffer.from(`data: ${JSON.stringify({ ...head, ...(chunk as object) })}\n\n`);
const realUsage = (extra: { write?: number; part?: boolean; cost: number }) => ({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: extra.cost, is_byok: false,
 prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: extra.write ?? 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0 },
 cost_details: { upstream_inference_cost: extra.cost, upstream_inference_prompt_cost: extra.cost / 2, upstream_inference_completions_cost: extra.cost / 2, ...(extra.part ? { upstream_inference_cache_write_cost: 0.0000005 } : {}) } });

async function world(meterFor?: () => DynamoMeter) {
 const tariffs = [tariff];
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: tariffs }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: tariffs, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${MODEL}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 expect(quote.status).toBe(200);
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: tariffs, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 if (meterFor) w.deps.meter = meterFor();
 const token = mint({ mdl: [MODEL], runPrice: (quote.body as { runPrice: RunPrice }).runPrice });
 const use = (chunks: Buffer[], stream = true) => {
  const transport = vi.fn(async () => translatedAnswer("openrouter", { model: MODEL, streaming: stream }, 200, (async function* () { for (const c of chunks) yield c; })(), () => undefined));
  w.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport } };
  return transport;
 };
 return { w, token, use };
}
const durableTables = () => { const tables = { meter: "meter", ledger: "ledger", markers: "markers" }; return { tables, wire: new WireDynamo(Object.values(tables)) }; };
const durable = (wire: WireDynamo, tables: { meter: string; ledger: string; markers: string }) => new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });

type Extra = { write?: number; part?: boolean };
const stopOf = (meter: unknown) => (meter as { sourceStop(iss: string, cid: string, source: string, routeClass: string): Promise<unknown> }).sourceStop(claims.iss, claims.cid, "openrouter", "agent");
const cases: [string, Extra][] = [["write tokens", { write: 2 }], ["a write cost part only", { part: true }]];
it.each(cases.flatMap(([name, extra]) => [false, true].map(isDurable => [name, extra, isDurable] as const)))("R1 stream, write only in the FINAL usage chunk after the content streamed (%s, durable=%s): stopped, settled safely, latched", async (_name, extra, isDurable) => {
 const { tables, wire } = durableTables();
 const { w, token, use } = await world(isDurable ? () => durable(wire, tables) : undefined);
 const debit = 0.000004; // below the hold: only the write makes this call unsafe
 const transport = use([
  sse({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null, native_finish_reason: null, logprobs: null }] }),
  sse({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop", native_finish_reason: "stop", logprobs: null }] }),
  sse({ choices: [], usage: realUsage({ ...extra, cost: debit }) }),
  Buffer.from("data: [DONE]\n\n"),
 ]);
 const reserve = vi.spyOn(w.deps.meter, "reserve"); const settle = vi.spyOn(w.deps.meter, "settleV2" as never) as unknown as { mock: { calls: [{ receipt: { status: string; amountMicros: { value: number }; usage: { value: Record<string, number> } }; noWriteRoute?: boolean }][] } };
 const result = await call(w.deps, { ...requestBody, model: MODEL, stream: true }, token);
 // The content DID reach the client before the write was known ...
 expect(result.status).toBe(200);
 expect(result.text()).toContain("\"text\":\"ok\"");
 // ... yet the call is stopped (destroyed, never ended cleanly) ...
 expect(result.destroyed).toBe(true); expect(result.ended).toBe(false);
 // ... and settles at max(hold, reported, token cost with the write at the highest listed price), never below the hold.
 const held = (reserve.mock.calls[0]![0] as { estimateMicros: number }).estimateMicros;
 const { receipt, noWriteRoute } = settle.mock.calls[0]![0];
 expect(noWriteRoute).toBe(true);
 expect(receipt.amountMicros.value).toBe(Math.max(held, Math.ceil(debit * 1e6), (10 - (extra.write ?? 1)) * 1 + (extra.write ?? 1) * 3 + 1 * 2));
 expect(receipt.amountMicros.value).toBeGreaterThanOrEqual(held);
 expect(receipt.status).not.toBe("final");
 expect(receipt.usage.value.cacheWriteUnknown).toBe(extra.write ?? 1);
 // ... and the route is refused afterwards, with no second send.
 expect(await stopOf(w.deps.meter)).toMatchObject({ stopped: true });
 expect((await call(w.deps, { ...requestBody, model: MODEL, stream: true }, token)).status).toBeGreaterThanOrEqual(400);
 expect(transport).toHaveBeenCalledTimes(1);
});

it.each([["write tokens", { write: 2 }], ["a write cost part", { part: true }]] as const)("R2 a later usage chunk without the write cannot erase it (%s)", async (_name, extra) => {
 const { w, token, use } = await world();
 use([
  sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }], usage: realUsage({ ...extra, cost: 0.000002 }) }),
  sse({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }),
  sse({ choices: [], usage: realUsage({ cost: 0.000004 }) }),
  Buffer.from("data: [DONE]\n\n"),
 ]);
 const result = await call(w.deps, { ...requestBody, model: MODEL, stream: true }, token);
 expect(result.destroyed).toBe(true);
 expect(await stopOf(w.deps.meter)).toMatchObject({ stopped: true });
});

it("R3 two gateway instances on ONE durable meter: a write on instance A refuses the route on instance B (no send)", async () => {
 const { tables, wire } = durableTables();
 const a = await world(() => durable(wire, tables));
 const b = await world(() => durable(wire, tables));
 a.use([sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }), sse({ choices: [], usage: realUsage({ write: 1, cost: 0.000004 }) }), Buffer.from("data: [DONE]\n\n")]);
 const sentB = b.use([sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }), sse({ choices: [], usage: realUsage({ cost: 0.000004 }) }), Buffer.from("data: [DONE]\n\n")]);
 expect((await call(a.w.deps, { ...requestBody, model: MODEL, stream: true }, a.token)).destroyed).toBe(true);
 const refused = await call(b.w.deps, { ...requestBody, model: MODEL, stream: true }, b.token);
 expect(refused.status).toBeGreaterThanOrEqual(400);
 expect(sentB).not.toHaveBeenCalled();
});
