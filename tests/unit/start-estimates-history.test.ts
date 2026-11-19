import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID } from "@agentx/contracts";
import { startEstimates } from "../../packages/broker/src/core/cost/start-estimates.js";
const av = <T>(value: T) => ({ state: "available" as const, value });
const un = { state: "unavailable" as const, reason: "not_applicable" as const };
const orgId = "org_corehost00000000000a", asOf = "2026-11-18T12:00:00.000Z";
const model = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const source = { kind: "rovara_ai" as const, id: "rovara", name: "Rovara AI", provider: "anthropic", connectionRevision: "1" };
const price = { authority: "gateway" as const, version: "1", hash: "a".repeat(64), fetchedAt: "2026-11-18T11:00:00.000Z" };
const sample = (id: number, path = "QUICK") => ({ version: 1, companyId: orgId, project: "web", taskId: `t${id}`, purpose: un, agentId: ROVARA_CODE_AGENT_ID, path, outcome: "completed", workflowVersion: av("1.1.0"), optionsVersion: av("start-preview-v2:000"), calls: [{ callId: `c${id}`, stage: "build", granularity: "call", model: av(model), source: av(source), price: av(price), usage: av({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 }), settledMicros: av(id * 1_000_000), status: "final" }], callCount: av(1), completionCoverage: "complete", priceCoverage: "complete", endedAt: "2026-11-18T11:30:00.000Z", revision: 1, startQuote: { state: "unavailable", reason: "legacy_data" } });
const rows = (samples: unknown[]) => samples.map((s, i) => ({ pk: `ORG#${orgId}#RUN_USAGE#web`, sk: `t${i}`, entityType: "RUN_USAGE_SAMPLE", companyId: orgId, project: "web", sample: s }));
const input = { orgId, project: "web", request: { quoteVersion: 2 as const }, asOf, context: { policyRevision: "1", stages: { build: { model: av(model), source: av(source), price: av(price) } }, limits: [] } };
const read = (samples: unknown[], request = input.request) => startEstimates({ store: { query: async q => ({ items: q.pk.endsWith("#RUN_USAGE#web") ? rows(samples) : [] }) } }, { ...input, request });
describe("normalized run history for start quotes", () => {
 it("uses five compatible complete final samples and preserves honest non-model-priced labeling", async () => {
  const q = await read([1,2,3,4,5].map(i => sample(i)));
  expect(q.options[0].range).toEqual(av({ lowMicros: 3_000_000, highMicros: 4_000_000 }));
  expect(q.options[0].basis).toMatchObject({ kind: "history", samples: 5, effectiveSamples: 5, modelPriced: false, newestSampleAt: av("2026-11-18T11:30:00.000Z") });
  expect(q.options[1].basis.kind).toBe("default");
 });
 it("keeps censored, provisional, mismatched model/source/price/options and malformed samples out of the cohort", async () => {
  const base = sample(5);
  const samples = [sample(1), sample(2), sample(3), sample(4),
   { ...base, outcome: "cap_stopped" }, { ...base, completionCoverage: "partial" },
   { ...base, optionsVersion: av("different") }, { ...base, companyId: "org_bbbbbbbbbbbbbbbbbbbb" },
   ...[{ status: "awaiting_usage" }, { model: av({ ...model, modelId: "different" }) }, { source: av({ ...source, connectionRevision: "2" }) }, { price: av({ ...price, version: "2" }) }, { settledMicros: av(-1) }].map(change => ({ ...base, calls: [{ ...base.calls[0], ...change }] })),
  ];
  expect((await read(samples)).options[0].basis.kind).toBe("default");
 });
 it("rejects rows that E's strict RunUsageSampleV1 contract refuses", async () => {
  const valid = sample(5);
  const { startQuote: _startQuote, ...missingQuote } = valid;
  void _startQuote;
  for (const invalid of [missingQuote, { ...valid, unexpected: true }, { ...valid, calls: [{ ...valid.calls[0], price: av({ ...price, hash: "bad" }) }] }]) {
   expect((await read([1,2,3,4].map(i => sample(i)).concat([invalid] as typeof valid[]))).options[0].basis.kind).toBe("default");
  }
 });
 it("deduplicates revisions by task and refuses a partial history page", async () => {
  const q = await read([1,2,3,4,5].flatMap(i => [sample(i), { ...sample(i), revision: 2 }]));
  expect(q.options[0].basis.samples).toBe(5);
  const partial = await startEstimates({ store: { query: async q => ({ items: q.pk.endsWith("#RUN_USAGE#web") ? rows([1,2,3,4,5].map(i => sample(i))) : [], cursor: "more" }) } }, input);
  expect(partial.options[0].range.state).toBe("unavailable");
 });
});
