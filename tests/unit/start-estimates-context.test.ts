import { expect, it, vi } from "vitest";
import { companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { hostedPreviewContext } from "../../packages/broker/src/core-host/start-estimates.js";
import { startEstimates } from "../../packages/broker/src/core/cost/start-estimates.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
it("reads admission caps and model choices without publishing state, invoking AI or taking money", async () => {
 const world = createFakeWorld(), now = () => new Date("2026-11-18T12:00:00.000Z");
 await world.store.put({ item: { ...companyDayKey(FAKE_COMPANY, "2026-11-18"), loadMicros: 4_000_000, reservedMicros: 3_000_000, usdMicros: 1_000_000, uncountedEntries: 0 } });
 const put = vi.spyOn(world.store, "put"), transact = vi.spyOn(world.store, "transact");
 const context = await hostedPreviewContext({ store: world.store, companyId: FAKE_COMPANY, project: "web", now, settings: { allowedCompanies: "all", taskCapMicros: 3_000_000, companyDayCapMicros: 5_000_000 }, projectTaskCap: async () => 2_000_000, defaultRoute: async () => ({ alias: "claude-sonnet-4-6", api: "anthropic-messages" }) });
 const quote = await startEstimates({ store: world.store }, { orgId: FAKE_COMPANY, project: "web", request: { quoteVersion: 2 }, asOf: now().toISOString(), context });
 expect(quote.options[0].firstBindingLimit).toMatchObject({ state: "available", value: { scope: "engine_day", availableMicros: 1_000_000, blocked: true, reason: "held", requiredMicros: { state: "available", value: 2_000_000 } } });
 expect(quote.options[1].initialHoldMicros).toEqual({ state: "available", value: 2_000_000 });
 expect(context.stages.build?.model).toEqual({ state: "available", value: { provider: "anthropic", modelId: "claude-sonnet-4-6" } });
 expect(context.stages.build?.price.state).toBe("unavailable");
 expect(put).not.toHaveBeenCalled();expect(transact).not.toHaveBeenCalled();
});
it("keeps unreadable project/day limits partial and never invents an initial hold", async () => {
 const world = createFakeWorld(), now = () => new Date("2026-11-18T12:00:00.000Z");
 await world.store.put({ item: { ...companyDayKey(FAKE_COMPANY, "2026-11-18"), loadMicros: 1, uncountedEntries: 1 } });
 const context = await hostedPreviewContext({ store: world.store, companyId: FAKE_COMPANY, project: "web", now, settings: { allowedCompanies: "all", taskCapMicros: 3_000_000, companyDayCapMicros: 5_000_000 }, projectTaskCap: async () => { throw new Error("unreadable"); }, defaultRoute: async () => undefined });
 const quote = await startEstimates({ store: world.store }, { orgId: FAKE_COMPANY, project: "web", request: { quoteVersion: 2 }, asOf: now().toISOString(), context });
 expect(quote.options[0].initialHoldMicros.state).toBe("unavailable");
 expect(quote.options[0].limitCoverage).toBe("partial");
 expect(quote.options[0].firstBindingLimit).not.toEqual({ state: "available", value: null });
});

it("refreshes source/model/price identity from the approved rate read and bounds quote expiry without reserving", async () => {
 const world = createFakeWorld(), now = () => new Date("2026-11-18T12:00:00.000Z");
 let revision = "1", calls = 0;
 const read = async () => {
  calls++;
  return { model: { provider: "bedrock", modelId: "served-model" }, source: { kind: "company_key" as const, id: "company-key", name: "Company AI", provider: "bedrock", connectionRevision: revision }, ref: { authority: "gateway" as const, version: revision, hash: "a".repeat(64), fetchedAt: "2026-11-18T11:00:00.000Z" }, expiresAt: "2026-11-18T12:00:20.000Z" };
 };
 const args = { store: world.store, companyId: FAKE_COMPANY, project: "web", now, rateQuote: read, defaultRoute: async () => ({ alias: "claude-sonnet-4-6", api: "anthropic-messages" as const }) };
 const firstContext = await hostedPreviewContext(args);
 expect(calls).toBe(1);
 const first = await startEstimates({ store: world.store }, { orgId: FAKE_COMPANY, project: "web", request: { quoteVersion: 2 }, asOf: now().toISOString(), context: firstContext });
 expect(first.expiresAt).toBe("2026-11-18T12:00:20.000Z");
 expect(first.options[0].stages[0].source).toMatchObject({ state: "available", value: { connectionRevision: "1" } });
 revision = "2";
 const second = await startEstimates({ store: world.store }, { orgId: FAKE_COMPANY, project: "web", request: { quoteVersion: 2 }, asOf: now().toISOString(), context: await hostedPreviewContext(args) });
 expect(second.inputsDigest).not.toBe(first.inputsDigest);
 expect(second.options[0].basis.modelPriced).toBe(false);
});
