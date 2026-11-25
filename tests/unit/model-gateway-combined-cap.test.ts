// DEC 228c: ONE company monthly cap over the agent route and the product route together. The product meter takes the agent
// meter's company row (and its one-overrun-call-in-flight marker) in the same conditional transaction as its own rows, so
// parallel calls on both routes can never hold or spend past the cap by more than one call (DEC 165). Fail closed throughout.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { InMemoryMeter, type Meter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import { createProductCaps } from "../../packages/model-gateway/src/product-route.js";
import type { ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { answer, call, caps as agentCaps, now, scope as agentScope } from "./model-gateway-fixture.js";
import { geminiAnswer, productCall, productGateway, productScope } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const AGENT = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" };
const PRODUCT = { meter: "gwp-meter", ledger: "gwp-ledger", markers: "gwp-markers" };
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
function dynamoPair(clock: () => number = () => now) {
  const wire = new WireDynamo([...Object.values(AGENT), ...Object.values(PRODUCT)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
  const agent = new DynamoMeter({ db, tables: AGENT, now: clock });
  const product = new DynamoMeter({ db, tables: PRODUCT, now: clock, combinedCompany: { meter: AGENT.meter, markers: AGENT.markers } });
  return { wire, db, agent, product };
}
function memoryPair() {
  const agent = new InMemoryMeter(() => now);
  return { agent, product: new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent }) };
}
const company = async (meter: Meter, scope: MeterScope = agentScope) => (await meter.read(scope)).find((row) => row.item === "company")!;
const big = 1_000_000;
const productCaps = (combined: number) => ({ task: big, projectMonth: big, companyMonth: big, combinedCompanyMonth: combined });
const agentCapsOf = (companyMonth: number) => ({ task: big, personMonth: big, projectMonth: big, companyMonth });

for (const [name, make] of [["InMemoryMeter", memoryPair], ["DynamoMeter at the wire", dynamoPair]] as const) {
  describe(`combined company cap: ${name}`, () => {
    it("a product hold takes room on the agent meter's company row, and an agent hold takes room the product route then lacks", async () => {
      const { agent, product } = make();
      const p = await product.reserve({ scope: productScope, caps: productCaps(100), estimateMicros: 60 }); expect(p.ok).toBe(true);
      expect(await company(agent)).toMatchObject({ reservedMicros: 60, committed: 60, spentMicros: 0 });
      expect(await agent.reserve({ scope: agentScope, caps: agentCapsOf(100), estimateMicros: 41 })).toEqual({ ok: false, reason: "cap", item: "company", held: true });
      expect((await agent.reserve({ scope: agentScope, caps: agentCapsOf(100), estimateMicros: 40 })).ok).toBe(true);
      expect(await product.reserve({ scope: productScope, caps: productCaps(100), estimateMicros: 1 })).toEqual({ ok: false, reason: "cap", item: "company", held: true });
      // The product meter's own rows stay its own: only three rows, none of them the combined row.
      expect((await product.read(productScope)).map((row) => row.item)).toEqual(["task", "project", "company"]);
      expect((await company(product, productScope)).reservedMicros).toBe(60);
    });

    it("settles to the combined row; a product settle past the combined cap blocks the AGENT route too (one call over, DEC 165)", async () => {
      const { agent, product } = make();
      const p = await product.reserve({ scope: productScope, caps: productCaps(100), estimateMicros: 90 }); if (!p.ok) throw new Error("reserve");
      await product.settle(p.reservation, 101);
      expect(await company(agent)).toMatchObject({ spentMicros: 101, reservedMicros: 0, committed: 101, overrun: true });
      // The product meter's own company row (the product ceiling, here 1,000,000) is not over.
      expect((await company(product, productScope)).overrun).toBe(false);
      expect(await agent.reserve({ scope: agentScope, caps: agentCapsOf(1_000), estimateMicros: 1 })).toEqual({ ok: false, reason: "overrun", item: "company", held: false });
    });

    it("fails closed: a combined meter given no combined company cap holds nothing anywhere", async () => {
      const { agent, product } = make();
      expect(await product.reserve({ scope: productScope, caps: { task: big, projectMonth: big, companyMonth: big }, estimateMicros: 1 })).toEqual({ ok: false, reason: "busy" });
      expect(await company(agent)).toMatchObject({ reservedMicros: 0, committed: 0 });
      expect((await product.read(productScope)).every((row) => row.committed === 0)).toBe(true);
      expect(product.combinedCompany).toBe(true);
      expect(agent.combinedCompany).toBe(false);
    });

    it("one overrun-capable call in flight per company across BOTH routes", async () => {
      const { agent, product } = make();
      const marker = { deadlineSeconds: now / 1000 + 60, tokenExpiresSeconds: now / 1000 + 900 };
      const p = await product.reserve({ scope: productScope, caps: productCaps(big), estimateMicros: 10, overrun: marker }); if (!p.ok) throw new Error("reserve");
      expect(await agent.reserve({ scope: agentScope, caps: agentCaps, estimateMicros: 10, overrun: marker })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
      // A bounded priced agent call is not serialized behind it.
      expect((await agent.reserve({ scope: agentScope, caps: agentCaps, estimateMicros: 10 })).ok).toBe(true);
      await product.settle(p.reservation, 10);
      const a = await agent.reserve({ scope: agentScope, caps: agentCaps, estimateMicros: 10, overrun: marker }); expect(a.ok).toBe(true);
      expect(await product.reserve({ scope: productScope, caps: productCaps(big), estimateMicros: 10, overrun: marker })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
    });

    it("a product price correction moves the combined row too, judged against the combined cap", async () => {
      const { agent, product } = make();
      const p = await product.reserve({ scope: productScope, caps: productCaps(100), estimateMicros: 50 }); if (!p.ok) throw new Error("reserve");
      await product.settle(p.reservation, 50, { provider: "gemini", model: "m", kind: "chat", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: now });
      const pending = (await product.pendingFor({ provider: "gemini", model: "m" }, 1)).items[0]!;
      const result = await product.correct({ callKey: pending.callKey, realMicros: 120, caps: productCaps(100), priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: now }, runId: "r", now });
      expect(result).toEqual({ status: "corrected", deltaMicros: 70, capExceeded: true });
      expect(await company(agent)).toMatchObject({ spentMicros: 120, overrun: true });
      expect((await company(product, productScope)).overrun).toBe(false);
    });
  });
}

describe("combined company cap: wiring", () => {
  it("the product caps carry the company backend's monthly cap as the combined cap; no monthly cap is no product call", async () => {
    const keys = { capsFor: async () => ({ caps: { taskMicros: 5, projectMonthMicros: 6 }, companyMonthMicros: 7 }) } as unknown as Parameters<typeof createProductCaps>[0];
    expect(await createProductCaps(keys, new FixedCapsSource({ task: 1, projectMonth: 1, companyMonth: 100 })).capsFor(productScope)).toEqual({ task: 5, projectMonth: 6, companyMonth: 7, combinedCompanyMonth: 100 });
    expect(await createProductCaps(keys, new FixedCapsSource({ task: 1, projectMonth: 1 })).capsFor(productScope)).toEqual({});
  });
  it("a product route whose meter is not combined answers 503 and sends nothing", async () => {
    const g = await productGateway({ productMeter: new InMemoryMeter(() => now) });
    const sink = await productCall(g.deps);
    expect(sink.status).toBe(503); expect(g.productCalls).toHaveLength(0);
  });
  it("a DynamoMeter refuses to combine with its own meter table", () => {
    const { db } = dynamoPair();
    expect(() => new DynamoMeter({ db, tables: AGENT, combinedCompany: { meter: AGENT.meter, markers: AGENT.markers } })).toThrow("meter unavailable");
  });
  it("an InMemoryMeter refuses to combine with itself or with a combined meter", () => {
    const { product } = memoryPair();
    expect(() => new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: product })).toThrow("meter unavailable");
  });
});

/** Every call of both routes is held open at the transport until all of them have been admitted or refused. */
async function race(meters: { agent: Meter; product: Meter }, cap: number, perRoute: number, productFirst: boolean) {
  let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; });
  let peak = 0;
  const sample = async () => { peak = Math.max(peak, (await company(meters.agent)).committed); };
  const agentTransport: ProviderTransport = async () => { await sample(); await opened; return { status: 200, body: answer() }; };
  const productTransport: ProviderTransport = async () => { await sample(); await opened; return { status: 200, body: geminiAnswer() }; };
  const g = await productGateway({
    productMeter: meters.product, transport: productTransport, companyCaps: new FixedCapsSource({ task: big * 1000, projectMonth: big * 1000, companyMonth: cap }),
    overrides: { meter: meters.agent, caps: new FixedCapsSource(agentCapsOf(cap)), transport: agentTransport },
  });
  // All started at once (the product route's admission reads more first, so it is started first when asked); the admitted
  // ones wait at the transport until every call has been decided.
  const products = productFirst ? Array.from({ length: perRoute }, () => productCall(g.deps)) : [];
  // The product route's admission reads the key store first: give it a head start of one timer turn so both routes are
  // deciding against the company row at the same time.
  if (productFirst) await new Promise((resolve) => setTimeout(resolve, 1));
  const agents = Array.from({ length: perRoute }, () => call(g.deps));
  if (!productFirst) products.push(...Array.from({ length: perRoute }, () => productCall(g.deps)));
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  open();
  const [agentSinks, productSinks] = [await Promise.all(agents), await Promise.all(products)];
  const sinks = [...agentSinks, ...productSinks];
  return { sinks, peak, final: await company(meters.agent), agentOk: agentSinks.filter((s) => s.status === 200).length, productOk: productSinks.filter((s) => s.status === 200).length };
}
describe("combined company cap: two routes racing", () => {
  for (const [name, make] of [["InMemoryMeter", memoryPair], ["DynamoMeter at the wire", dynamoPair]] as const) {
    it(`${name}: parallel agent and product calls never hold or spend past the one company cap`, async () => {
      // One call of each route held at once shows the two holds together; the cap then fits about two of each.
      const probe = await race(make(), big * 1000, 1, true);
      expect(probe.agentOk + probe.productOk).toBe(2);
      const cap = probe.peak * 2;
      let agentOk = 0; let productOk = 0;
      for (const productFirst of [true, false]) {
        const result = await race(make(), cap, 8, productFirst);
        agentOk += result.agentOk; productOk += result.productOk;
        // Refused at the company row: held by the other calls' holds (429) while spend is still under the cap.
        expect(result.sinks.some((s) => s.status === 429 && s.text().includes("budget_held"))).toBe(true);
        expect(result.sinks.every((s) => s.status === 200 || s.status === 429 || s.status === 503)).toBe(true);
        expect(result.peak).toBeLessThanOrEqual(cap);
        expect(result.final.spentMicros).toBeLessThanOrEqual(cap);
        expect(result.final).toMatchObject({ reservedMicros: 0, overrun: false });
        expect(result.final.committed).toBe(result.final.spentMicros);
      }
      // Both routes were admitted against the one row.
      expect(agentOk).toBeGreaterThan(0);
      expect(productOk).toBeGreaterThan(0);
    });
  }
});
