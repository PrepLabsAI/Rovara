// The gateway's refusal log line names WHICH run-price check refused a `run_price_authorization_required` call (a fixed word per check), so a refusal can be
// proven from logs. LOG ONLY: the client's status, code and words are pinned unchanged here. Fixed words only: no token, price, prompt or id in the line.
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, mint, now, setup } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { parseTaskClaims, type RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { runPriceDenial, type RunPriceDenial } from "../../packages/model-gateway/src/run-price.js";
import type { RefusedLog } from "../../packages/model-gateway/src/server.js";

beforeAll(denyNetwork);
const pi = JSON.parse(readFileSync(new URL("../fixtures/model-gateway/pi-ai-1.5.2-anthropic-messages.json", import.meta.url), "utf8")) as { model: string; system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; tools: Array<Record<string, unknown>>; stream: boolean; max_tokens: number };
const catalog = "us.anthropic.claude-sonnet-4-5-v1:0";
const CHANGED = "AI source or price changed; pause this run for fresh authorization.";
const IMAGE = "This image can't be priced (only inline png, jpeg, gif or webp up to the size limit can be sent). Send it inline or leave it out.";
const CACHE = "This model has no known cache-write price; pause this run for fresh authorization.";
const refusals = (logs: readonly unknown[]) => logs.filter((line): line is RefusedLog => (line as { event?: unknown }).event === "refused");
const body = (type: string, message: string) => JSON.stringify({ error: { type, message } });

/** The operator-account agent route with a signed run price (the quote the gateway itself issues). `rates` omit cache writes when `noWrite`. */
async function world(noWrite = false) {
  const rates = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000, ...(noWrite ? {} : { cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 6_000_000 }) };
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: catalog, kind: "chat", ...rates }] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const rovara = { sourceId: "operator-account@region", models: new Map([[pi.model, catalog]]), exempt: new Set<string>() };
  const sources = { sourceFor: async () => "rovara" as const };
  const keys = { connected: async () => false, keyFor: async () => undefined };
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys, rovara,
    verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${pi.model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice;
  expect(grant).toBeDefined();
  const f = setup({ prices, agentKeys: keys, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  f.deps.agentAi = { sources, rovara: { ...rovara, transport: f.deps.transport } };
  const plain = { model: pi.model, messages: [{ role: "user", content: "PROMPT-CANARY" }], max_tokens: 10, stream: true };
  const run = async (changes: Partial<RunPrice> | undefined, request: unknown = plain, now2?: () => number) => {
    if (now2 !== undefined) f.deps.now = now2;
    const sink = await call(f.deps, request, mint({ mdl: [pi.model], ...(changes === undefined ? {} : { runPrice: { ...grant, ...changes } }) }));
    return { sink, lines: refusals(f.logs), sent: f.calls.length };
  };
  return { ...f, grant, run, plain };
}
const cached = () => { const b = structuredClone(pi); for (const block of [...b.system, ...b.messages[0]!.content, ...b.tools]) delete block.cache_control; b.system[0]!.cache_control = { type: "ephemeral" }; return b; };
const expected = (reason: string, message = CHANGED) => ({ event: "refused", code: "run_price_authorization_required", status: 409, route: "agent", payer: "rovara", reason, _message: message });
async function refusedWith(changes: Partial<RunPrice> | undefined, reason: string, opts: { request?: (w: Awaited<ReturnType<typeof world>>) => unknown; noWrite?: boolean; message?: string; now?: () => number } = {}) {
  const w = await world(opts.noWrite);
  const out = await w.run(changes, opts.request?.(w) ?? w.plain, opts.now);
  const { _message, ...line } = expected(reason, opts.message);
  expect(out.lines).toEqual([line]);
  // The client's answer is exactly what it was before the reason existed: same status, same code, same words, no reason.
  expect(out.sink.status).toBe(409);
  expect(out.sink.text()).toBe(body("run_price_authorization_required", _message));
  expect(out.sent).toBe(0);
  expect(JSON.stringify(w.logs)).not.toMatch(/PROMPT-CANARY|fixture-|eyJ|AAAA/u);
}

it("a signed authorization for another model, provider, source or revision is refused with its own reason", async () => {
  await refusedWith({ catalogModel: "other-model" }, "model_mismatch");
  await refusedWith({ provider: "anthropic" }, "provider_mismatch");
  await refusedWith({ sourceId: "another-account@region" }, "source_mismatch");
  await refusedWith({ connectionRevision: "rotated" }, "connection_changed");
});
it("an expired authorization says token_expired", async () => {
  const w = await world();
  await refusedWith({ expiresAt: now + 1_000 }, "token_expired", { now: () => now + 2_000 });
  expect(w.grant.expiresAt).toBeGreaterThan(now);
});
it("a price basis that moved says which part: missing, hash, version", async () => {
  await refusedWith({ snapshotHash: "0".repeat(64) }, "snapshot_mismatch");
  await refusedWith({ snapshotVersion: 8 }, "snapshot_version_mismatch");
  const w = await world();
  w.deps.prices = { priceFor: w.deps.prices!.priceFor.bind(w.deps.prices) };
  const out = await w.run({});
  expect(out.lines).toEqual([{ event: "refused", code: "run_price_authorization_required", status: 409, route: "agent", payer: "rovara", reason: "price_basis_missing" }]);
  expect(out.sink.text()).toBe(body("run_price_authorization_required", CHANGED));
});
it("a rate above the signed ceiling says rate_above_ceiling", async () => {
  const w = await world();
  await refusedWith({ inputUsdPerMillion: w.grant.inputUsdPerMillion / 2 }, "rate_above_ceiling");
});
it("a request the price cannot bound says input_unbounded, an unpriceable image image_unbounded", async () => {
  await refusedWith({}, "input_unbounded", { request: (w) => ({ ...w.plain, messages: [{ role: "user", content: [{ type: 1 }] }] }) });
  await refusedWith({}, "image_unbounded", { message: IMAGE, request: (w) => ({ ...w.plain, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/private" } }] }] }) });
});
it("a cached call with no known cache-write price says cache_write_price_unknown", async () => {
  await refusedWith({}, "cache_write_price_unknown", { noWrite: true, message: CACHE, request: () => cached() });
});
it("an admitted call logs no reason, and a mutant reason or a missing reason is caught by the exact-line pins above", async () => {
  const w = await world();
  const ok = await call(w.deps, w.plain, mint({ mdl: [pi.model], runPrice: w.grant }));
  expect(ok.status).toBe(200);
  expect(refusals(w.logs)).toEqual([]);
});

it("every direct check of the signed authorization names itself (unit)", () => {
  const base: RunPrice = { companyId: claims.cid, model: pi.model, catalogModel: catalog, provider: "bedrock", sourceId: "s", connectionRevision: "r", expiresAt: now + 60_000, snapshotHash: "h", snapshotVersion: 9, inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 6 };
  const source = { source: { kind: "rovara_ai" as const, id: "s", name: "Operator AI", provider: "bedrock", connectionRevision: "r" }, billing: "customer" as const };
  const price = { estimated: false, priceVersion: 9, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000, cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 6_000_000 };
  const check = (grant: Partial<RunPrice>, over: { price?: object; source?: typeof source | undefined; provider?: string; model?: string; at?: number; tariffs?: unknown[] } = {}): RunPriceDenial | undefined =>
    runPriceDenial({ ...parseTaskClaims({ ...claims, mdl: [pi.model] })!, runPrice: { ...base, ...grant } }, over.provider ?? "bedrock", over.model ?? catalog, "source" in over ? over.source : source, { ...price, ...over.price }, over.at ?? now, over.tariffs as never);
  expect(check({})).toBeUndefined();
  expect(check({ companyId: `org_${"b".repeat(20)}` })).toBe("company_mismatch");
  expect(check({ model: "x" })).toBe("model_mismatch");
  expect(check({ catalogModel: "x" })).toBe("model_mismatch");
  expect(check({ expiresAt: now })).toBe("token_expired");
  expect(check({ provider: "anthropic" })).toBe("provider_mismatch");
  expect(check({}, { provider: "anthropic" })).toBe("provider_mismatch");
  expect(check({}, { source: undefined })).toBe("provider_mismatch");
  expect(check({ sourceId: "t" })).toBe("source_mismatch");
  expect(check({ connectionRevision: "q" })).toBe("connection_changed");
  expect(check({}, { price: { operatorReview: true } })).toBe("price_operator_review");
  expect(check({}, { price: { estimated: true } })).toBe("price_estimated");
  expect(check({ snapshotVersion: 8 })).toBe("price_version_changed");
  expect(check({ outputUsdPerMillion: 1 })).toBe("rate_above_ceiling");
  expect(check({ cacheWriteUsdPerMillion: 5 })).toBe("rate_above_ceiling");
  // OpenRouter: the effective tariff's hash must be the signed one.
  expect(check({ provider: "openrouter", snapshotHash: "stale" }, { provider: "openrouter", source: { ...source, source: { ...source.source, provider: "openrouter" } }, tariffs: [] })).toBe("tariff_snapshot_changed");
  // A token with no run price is never denied here.
  expect(runPriceDenial(parseTaskClaims({ ...claims, mdl: [pi.model] })!, "bedrock", catalog, source, price as never, now)).toBeUndefined();
});

it("an OpenRouter source called without a signed run price says signed_price_missing, with the same answer as ever", async () => {
  const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
  const keys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
  const f = setup({ agentKeys: keys });
  f.deps.agentAi = { sources: { sourceFor: async () => "openrouter_key" as const }, switchedOn: new Set(["openrouter"]), openrouter: { transport: f.deps.transport } };
  const sink = await call(f.deps, { model: "vendor/model", messages: [{ role: "user", content: "PROMPT-CANARY" }], max_tokens: 10, stream: true }, mint({ mdl: ["vendor/model"] }));
  expect(sink.status).toBe(409);
  expect(sink.text()).toBe(body("run_price_authorization_required", "Authorize the current AI source and price before this run."));
  expect(refusals(f.logs)).toEqual([{ event: "refused", code: "run_price_authorization_required", status: 409, route: "agent", reason: "signed_price_missing" }]);
  expect(f.calls).toEqual([]);
});
