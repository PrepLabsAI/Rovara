import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startEstimates } from "../../packages/broker/src/core/cost/start-estimates.js";
import { parsePreviewV2, parsePreviewRequestV2 } from "../../packages/contracts/src/start-estimates.js";
const orgId = "org_corehost00000000000a";
const asOf = "2026-11-18T12:00:00.000Z";
const av = <T>(value: T) => ({ state: "available" as const, value });
const un = { state: "unavailable" as const, reason: "not_measured" as const };
const context = { policyRevision: "1", stages: {}, limits: [{ scope: "engine_day" as const, maximumMicros: av(5_000_000), availableMicros: av(1_000_000), heldMicros: av(4_000_000), resetAt: un }], initialHoldCeilingMicros: 5_000_000 };
const input = { orgId, project: "web", request: { quoteVersion: 2 as const }, asOf, context };
const store: Parameters<typeof startEstimates>[0]["store"] = { query: async () => ({ items: [] }) };
describe("advisory start comparison", () => {
 it("returns distinct default estimates, planning exposure and the start blocker without any writable capability", async () => {
  const quote = await startEstimates({ store }, input);
  expect(parsePreviewV2(quote)).toEqual(quote);
  expect(quote.options.map(q => [q.path, q.range, q.planningAllowanceMicros, q.initialHoldMicros])).toEqual([
   ["QUICK", av({ lowMicros: 1_000_000, highMicros: 3_000_000 }), av(2_000_000), av(2_000_000)],
   ["FULL", av({ lowMicros: 4_000_000, highMicros: 10_000_000 }), av(6_000_000), av(5_000_000)],
  ]);
  expect(quote.options[0].basis).toMatchObject({ kind: "default", samples: 0, modelPriced: false, confidence: "low", interval: un });
  expect(quote.options[0].firstBindingLimit).toEqual(av({ scope: "engine_day", appliesAt: "start", requiredMicros: av(2_000_000), availableMicros: 1_000_000, blocked: true, reason: "held" }));
  expect(quote.options[0].limitCoverage).toBe("partial");
  expect(Object.keys(store)).toEqual(["query"]);
 });
 it("labels the existing five-sample switch as history, never as model-priced or calibrated", async () => {
  const history: Parameters<typeof startEstimates>[0]["store"] = { query: async () => ({ items: [1, 2, 3, 4, 5].map(costUsd => ({ pk: "x", sk: "x", costUsd })) }) };
  const q = await startEstimates({ store: history }, input);
  expect(q.options[0].range).toEqual(av({ lowMicros: 3_000_000, highMicros: 4_000_000 }));
  expect(q.options[0].basis).toMatchObject({ kind: "history", samples: 5, effectiveSamples: 5, modelPriced: false, interval: un });
 });
 it("never presents an unknown optional increment as a whole-task range", async () => {
  const quote = await startEstimates({ store }, { ...input, request: { quoteVersion: 2, options: { eval: true } } });
  expect(quote.options[0].range.state).toBe("unavailable");
  expect(quote.options[0].stages.find(s => s.stage === "eval")).toMatchObject({ optional: true, included: true, range: { state: "unavailable" } });
  expect(quote.options[0]?.stages[0]?.range).toEqual(av({ lowMicros: 1_000_000, highMicros: 3_000_000 }));
 });
 it("refreshes identity for text, options, source, model, policy and price changes even at the same timestamp", async () => {
  const original = await startEstimates({ store }, input);
  for (const change of [
   { request: { quoteVersion: 2 as const, inputText: "changed" } },
   { request: { quoteVersion: 2 as const, options: { secondReview: true } } },
   { context: { ...context, policyRevision: "2" } },
   ...["model", "source", "price"].map(key => ({ context: { ...context, stages: { code: { model: un, source: un, price: un, [key]: av(key === "model" ? { provider: "anthropic", modelId: "changed" } : key === "source" ? { kind: "rovara_ai", id: "r", name: "R", provider: "anthropic", connectionRevision: "2" } : { authority: "gateway", version: "2", hash: "abc", fetchedAt: asOf }) } } } })),
  ]) {
   const next = await startEstimates({ store }, { ...input, ...change });
   expect(next.inputsDigest).not.toBe(original.inputsDigest);
   expect(next.quoteId).not.toBe(original.quoteId);
  }
 });
 it("keeps history failure and wholly unreadable limits unavailable", async () => {
  const quote = await startEstimates({ store: { query: async () => { throw new Error("down"); } } }, { ...input, context: { ...context, limits: [] } });
  expect(quote.options[0].range).toEqual({ state: "unavailable", reason: "unreadable" });
  expect(quote.options[0].firstBindingLimit.state).toBe("unavailable");
 });
 it("refuses malformed money, incomplete option pairs, unbounded options and unknown input fields", async () => {
  const quote = await startEstimates({ store }, input);
  expect(parsePreviewV2({ ...quote, options: [quote.options[0]] })).toBeUndefined();
  expect(parsePreviewV2({ ...quote, options: quote.options.map(q => ({ ...q, initialHoldMicros: av(-1) })) })).toBeUndefined();
  expect(parsePreviewRequestV2({ quoteVersion: 2, inputText: "x".repeat(4001) })).toBeUndefined();
  expect(parsePreviewRequestV2({ quoteVersion: 2, companyId: orgId })).toBeUndefined();
 });
});


it("strictly accepts the restricted binding's three states without accepting hidden figures", async () => {
 const { restrictPreviewV2 } = await import("../../packages/contracts/src/start-estimates.js");
 const quote = await startEstimates({ store }, input);
 for (const blocked of [true, false, null]) {
  const restricted = restrictPreviewV2(quote);
  for (const q of restricted.options) q.firstBindingLimit = av({ scope: "RESTRICTED", blocked, bindingScope: "engine_day" });
  expect(parsePreviewV2(restricted)).toEqual(restricted);
  for (const patch of [{ availableMicros: 123 }, { requiredMicros: av(123) }, { blocked: "false" }, { blocked: undefined }, { bindingScope: "other" }, { bindingScope: 123 }]) {
   expect(parsePreviewV2({ ...restricted, options: restricted.options.map(q => ({ ...q, firstBindingLimit: av({ scope: "RESTRICTED", blocked, ...patch }) })) })).toBeUndefined();
  }
  for (const patch of [{ limits: quote.options[0].limits }, { initialHoldMicros: av(123) }, { planningAllowanceMicros: av(123) }, { spentMicros: av(123) }, { taskMaximumMicros: av(-1) }, { range: av({ lowMicros: 3, highMicros: 2 }) }, { basis: quote.options[0].basis }, { stages: quote.options[0].stages }]) {
   expect(parsePreviewV2({ ...restricted, options: restricted.options.map(q => ({ ...q, ...patch })) })).toBeUndefined();
  }
 }
});


it("pins the mirrored PreviewV2 contract and member boundary", () => {
 const bytes = readFileSync("packages/contracts/src/start-estimates.ts");
 expect(createHash("sha256").update(bytes).digest("hex")).toBe("b426600eeed7ab865ba75dcf658fc93f2a7a857296dc185d3ec72f29388b320c");
});

 it("keeps only each binding scope and status when restricting a quote, idempotently", async () => {
  const { restrictPreviewV2 } = await import("../../packages/contracts/src/start-estimates.js");
  const numbers = (v: unknown): number[] => typeof v === "number" ? [v] : v !== null && typeof v === "object" ? Object.values(v).flatMap(numbers) : [];
  for (const scope of ["engine_task", "project_task", "engine_day", "gateway_task", "project_month", "person_month", "company_month", "purpose_month"] as const) {
   const raw = await startEstimates({ store }, { ...input, context: { ...context, limits: [{ ...context.limits[0]!, scope }] } });
   const member = restrictPreviewV2(raw);
   expect(parsePreviewV2(member)).toEqual(member);
   expect(restrictPreviewV2(member)).toEqual(member);
   for (const q of member.options) {
    const rawBinding = raw.options[member.options.indexOf(q)]!.firstBindingLimit;
    expect(q.firstBindingLimit).toEqual(av({ scope: "RESTRICTED", bindingScope: scope, blocked: rawBinding.state === "available" ? rawBinding.value?.blocked ?? null : null }));
    expect(numbers(q.firstBindingLimit)).toEqual([]);
   }
  }
 });


it("allows exactly the own-task range and tightest task maximum in member JSON", async () => {
 const { restrictPreviewV2 } = await import("../../packages/contracts/src/start-estimates.js");
 const numbers = (v: unknown): number[] => typeof v === "number" ? [v] : v !== null && typeof v === "object" ? Object.values(v).flatMap(numbers) : [];
 for (const scope of ["engine_task", "project_task", "gateway_task", "project_month", "person_month", "company_month"] as const) {
  const raw = await startEstimates({ store }, { ...input, context: { ...context, limits: [{ ...context.limits[0]!, scope }] } });
  const member = restrictPreviewV2(raw);
  expect(parsePreviewV2(member)).toEqual(member);
  const taskLimit = ["engine_task", "project_task", "gateway_task"].includes(scope);
  expect(numbers(member)).toEqual([2, 1_000_000, 3_000_000, ...(taskLimit ? [5_000_000] : []), 4_000_000, 10_000_000, ...(taskLimit ? [5_000_000] : [])]);
 }
});
