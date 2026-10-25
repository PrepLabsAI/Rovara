import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverModels, foundationModelIdOf, quotaHint, rankModels,
  type AvailabilityRow, type BedrockDiscoveryClient, type DiscoveryDependencies, type EligibleModel, type InferenceProfileRow, type ModelDiscoveryReport, type QuotaClient, type QuotaRow,
} from "../../packages/model-runtime/src/model-discovery.js";

// M1.4 Task 4.10C, tests 24 to 29: discovery, the tiers, and the bounds. Nothing here touches AWS or a provider.

const HAIKU_55_US = "us.anthropic.claude-haiku-5-5";
const HAIKU_55_GLOBAL = "global.anthropic.claude-haiku-5-5";
const HAIKU_45_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_GLOBAL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const NOW = Date.parse("2026-10-23T12:00:00Z");

const eligible = (modelId: string, price: number, scope: "geographic" | "global" | null = modelId.startsWith("global.") ? "global" : "geographic"): EligibleModel =>
  ({ modelId, label: modelId, inputUsdPerMTok: price, outputUsdPerMTok: price * 5, scope });
const ELIGIBLE = [eligible(HAIKU_55_US, 0.11), eligible(HAIKU_55_GLOBAL, 0.1), eligible(HAIKU_45_US, 1.1), eligible(HAIKU_45_GLOBAL, 1)];

const quotaRows: QuotaRow[] = [
  { code: "L-47520EB7", name: "Cross-region model inference tokens per minute for Anthropic Claude Haiku 5.5", value: 0 },
  { code: "L-F26CA8D1", name: "Global cross-region model inference tokens per minute for Anthropic Claude Haiku 5.5", value: 0 },
  { code: "L-HAIKU45GEO", name: "Cross-region model inference tokens per minute for Anthropic Claude Haiku 4.5", value: 5_000_000 },
  { code: "L-HAIKU45GLO", name: "Global cross-region model inference tokens per minute for Anthropic Claude Haiku 4.5", value: 10_000_000 },
];

function bedrockFake(overrides: Partial<BedrockDiscoveryClient> = {}): BedrockDiscoveryClient {
  const profiles: InferenceProfileRow[] = [HAIKU_55_US, HAIKU_55_GLOBAL, HAIKU_45_US, HAIKU_45_GLOBAL].map((id) => ({ id, status: "ACTIVE", foundationModelIds: [foundationModelIdOf(id)] }));
  const availability: Record<string, AvailabilityRow> = {
    "anthropic.claude-haiku-5-5": { agreement: "AVAILABLE", authorization: "AUTHORIZED" },
    "anthropic.claude-haiku-4-5-20251001-v1:0": { agreement: "AVAILABLE", authorization: "AUTHORIZED" },
  };
  return {
    listInferenceProfiles: async () => ({ profiles }),
    listFoundationModels: async () => [
      { modelId: "anthropic.claude-haiku-5-5", modelName: "Claude Haiku 5.5", providerName: "Anthropic" },
      { modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", modelName: "Claude Haiku 4.5", providerName: "Anthropic" },
    ],
    getAvailability: async (id) => availability[id] ?? { agreement: "NOT_AVAILABLE", authorization: "NOT_AUTHORIZED" },
    ...overrides,
  };
}
const quotaFake = (rows: readonly QuotaRow[] = quotaRows): QuotaClient => ({ list: async () => ({ quotas: rows }) });
const deps = (extra: Partial<DiscoveryDependencies> = {}): DiscoveryDependencies => ({ now: () => NOW, ...extra });
const candidates = ELIGIBLE.map((row) => row.modelId);

describe("Bedrock discovery (test 24)", () => {
  it("reads the TEST shape: Haiku 5.5 is limit-zero with both codes, Haiku 4.5 is available", async () => {
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: bedrockFake(), quotas: quotaFake() }));
    expect(report.status).toBe("listed");
    const by = new Map(report.models.map((row) => [row.modelId, row] as const));
    expect(by.get(HAIKU_55_US)).toMatchObject({ visible: true, state: "limit-zero" });
    expect(by.get(HAIKU_55_US)!.quotas).toEqual([{ scope: "geographic", code: "L-47520EB7", tokensPerMinute: 0 }, { scope: "global", code: "L-F26CA8D1", tokensPerMinute: 0 }]);
    expect(by.get(HAIKU_55_GLOBAL)!.state).toBe("limit-zero");
    expect(by.get(HAIKU_45_US)).toMatchObject({ visible: true, state: "available" });
    expect(by.get(HAIKU_45_US)!.quotas).toEqual([{ scope: "geographic", code: "L-HAIKU45GEO", tokensPerMinute: 5_000_000 }, { scope: "global", code: "L-HAIKU45GLO", tokensPerMinute: 10_000_000 }]);
  });

  it("decides a zero by the route's own scope: a US route with a zero global quota is not limit-zero", async () => {
    const rows = quotaRows.map((row) => (row.code === "L-47520EB7" ? { ...row, value: 10_000_000 } : row));
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: bedrockFake(), quotas: quotaFake(rows) }));
    const by = new Map(report.models.map((row) => [row.modelId, row] as const));
    expect(by.get(HAIKU_55_US)!.state).toBe("available");
    expect(by.get(HAIKU_55_GLOBAL)!.state).toBe("limit-zero");
  });

  it("a profile that is missing or not ACTIVE is not-in-region, and missing agreement is needs-access", async () => {
    const client = bedrockFake({
      listInferenceProfiles: async () => ({ profiles: [{ id: HAIKU_55_US, status: "ACTIVE", foundationModelIds: ["anthropic.claude-haiku-5-5"] }, { id: HAIKU_45_US, status: "LEGACY", foundationModelIds: ["anthropic.claude-haiku-4-5-20251001-v1:0"] }] }),
      getAvailability: async () => ({ agreement: "NOT_AVAILABLE", authorization: "NOT_AUTHORIZED" }),
    });
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: client }));
    const by = new Map(report.models.map((row) => [row.modelId, row] as const));
    expect(by.get(HAIKU_55_US)).toMatchObject({ visible: true, state: "needs-access" });
    expect(by.get(HAIKU_45_US)).toMatchObject({ visible: false, state: "not-in-region" });
    expect(by.get(HAIKU_55_GLOBAL)).toMatchObject({ visible: false, state: "not-in-region" });
  });

  it("matches a quota by name when the code is not known, and a quota nobody matches is null, never a state", async () => {
    const hint = await quotaHint({ modelId: HAIKU_45_US, region: "us-east-1", modelName: "Anthropic Claude Haiku 4.5" }, { quotas: quotaFake(), now: () => NOW });
    expect(hint).toEqual([{ scope: "geographic", code: "L-HAIKU45GEO", tokensPerMinute: 5_000_000 }, { scope: "global", code: "L-HAIKU45GLO", tokensPerMinute: 10_000_000 }]);
    // A "Haiku 4" label must not match the "Haiku 4.5" quota (exact match after the prefix).
    const other = await quotaHint({ modelId: "us.anthropic.claude-haiku-4", region: "us-east-1", modelName: "Anthropic Claude Haiku 4" }, { quotas: quotaFake(), now: () => NOW });
    expect(other).toEqual([{ scope: "geographic", code: null, tokensPerMinute: null }, { scope: "global", code: null, tokensPerMinute: null }]);
    // A known code works without a name.
    expect((await quotaHint({ modelId: HAIKU_55_US, region: "us-east-1" }, { quotas: quotaFake(), now: () => NOW }))[0]).toEqual({ scope: "geographic", code: "L-47520EB7", tokensPerMinute: 0 });
  });

  it("a denied quota lookup gives null hints and no throw", async () => {
    const denied: QuotaClient = { list: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
    const hint = await quotaHint({ modelId: HAIKU_55_US, region: "us-east-1" }, { quotas: denied, now: () => NOW });
    expect(hint).toEqual([{ scope: "geographic", code: "L-47520EB7", tokensPerMinute: null }, { scope: "global", code: "L-F26CA8D1", tokensPerMinute: null }]);
  });

  it("with no tests the tiers are Recommended Haiku 4.5 us. (the default is limit-zero) and Not usable Haiku 5.5", async () => {
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: bedrockFake(), quotas: quotaFake() }));
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended?.modelId).toBe(HAIKU_45_US);
    expect(ranked.why).toBe("default-not-usable");
    expect(ranked.notUsable.map((row) => [row.modelId, row.reason.code])).toEqual([[HAIKU_55_US, "limit-zero"], [HAIKU_55_GLOBAL, "limit-zero"]]);
    expect(ranked.canBeTested.map((row) => row.modelId)).toEqual([HAIKU_45_GLOBAL]);
    expect(ranked.worksOnAccount).toEqual([]);
  });
});

describe("discovery denied (test 25)", () => {
  it("ListInferenceProfiles AccessDenied is unverified/access-denied with no throw, and the recommendation is the overlay default", async () => {
    const client = bedrockFake({ listInferenceProfiles: async () => { throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }); } });
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: client, quotas: quotaFake() }));
    expect(report).toMatchObject({ status: "unverified", unverifiedReason: "access-denied", models: [] });
    expect(JSON.stringify(report)).not.toContain("not authorized");
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
    expect(ranked.why).toBe("discovery-unverified");
  });

  it("with no report at all, the same fallback", () => {
    const ranked = rankModels({ report: null, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [], current: HAIKU_45_US });
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
    expect(ranked.why).toBe("discovery-unverified");
    expect(ranked.canBeTested.map((row) => row.modelId)).toEqual([HAIKU_45_US]);
  });

  it("quotas denied only stays listed, without hints", async () => {
    const denied: QuotaClient = { list: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: bedrockFake(), quotas: denied }));
    expect(report.status).toBe("listed");
    const row = report.models.find((item) => item.modelId === HAIKU_55_US)!;
    expect(row.state).toBe("available");
    expect(row.quotas.every((entry) => entry.tokensPerMinute === null)).toBe(true);
  });
});

describe("Anthropic, OpenAI and OpenRouter discovery (tests 26 and 27)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("Anthropic: 401 is unverified/key-rejected; the key is sent once per page and never reported", async () => {
    const fetchFake = vi.fn(async () => json(401, { error: { message: "invalid x-api-key sk-ant-SECRETVALUE" } }));
    const report = await discoverModels({ provider: "anthropic", candidates: ["claude-haiku-5-5"] }, deps({ fetch: fetchFake, apiKey: async () => "sk-ant-SECRETVALUE" }));
    expect(report).toMatchObject({ status: "unverified", unverifiedReason: "key-rejected" });
    expect(JSON.stringify(report)).not.toContain("SECRETVALUE");
  });

  it("Anthropic: the pin counts as listed when only its dated snapshot is listed, and a different id does not", async () => {
    const fetchFake = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => json(200, { data: [{ id: "claude-haiku-5-5-20260601" }, { id: "claude-haiku-5-50-extra" }], has_more: false }));
    const report = await discoverModels({ provider: "anthropic", candidates: ["claude-haiku-5-5", "claude-haiku-9"] }, deps({ fetch: fetchFake, apiKey: async () => "k" }));
    expect(report.models).toMatchObject([{ modelId: "claude-haiku-5-5", visible: true, state: "available" }, { modelId: "claude-haiku-9", visible: false, state: "not-in-region" }]);
    expect(fetchFake.mock.calls[0]![1]).toMatchObject({ headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" } });
  });

  it("Anthropic: pages are capped at 3", async () => {
    const fetchFake = vi.fn(async () => json(200, { data: [{ id: "x" }], has_more: true, last_id: "x" }));
    await discoverModels({ provider: "anthropic", candidates: ["claude-haiku-5-5"] }, deps({ fetch: fetchFake, apiKey: async () => "k" }));
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it("OpenAI: listed is available, and a 404 listing (a gateway) is unverified/not-supported", async () => {
    const ok = await discoverModels({ provider: "openai", candidates: ["gpt-5.4-mini", "gpt-9"] }, deps({ fetch: (async () => json(200, { data: [{ id: "gpt-5.4-mini" }] })), apiKey: async () => "k" }));
    expect(ok.models.map((row) => [row.modelId, row.state])).toEqual([["gpt-5.4-mini", "available"], ["gpt-9", "not-in-region"]]);
    const gateway = await discoverModels({ provider: "openai", candidates: ["gpt-5.4-mini"] }, deps({ fetch: (async () => json(404, {})), apiKey: async () => "k" }));
    expect(gateway).toMatchObject({ status: "unverified", unverifiedReason: "not-supported" });
  });

  it("OpenRouter: an allowlist of amazon-bedrock with endpoints only from anthropic is not-in-region", async () => {
    const fetchFake = vi.fn(async (url: string) => (url.endsWith("/key") ? json(200, { data: { limit_remaining: 5 } })
      : json(200, { data: { endpoints: [{ tag: "anthropic", provider_name: "Anthropic" }] } })));
    const blocked = await discoverModels({ provider: "openrouter", candidates: ["anthropic/claude-haiku-5.5"], openRouterProviders: ["amazon-bedrock"] }, deps({ fetch: fetchFake as never, apiKey: async () => "k" }));
    expect(blocked.models).toMatchObject([{ visible: false, state: "not-in-region" }]);
    const allowed = await discoverModels({ provider: "openrouter", candidates: ["anthropic/claude-haiku-5.5"], openRouterProviders: ["anthropic"] }, deps({ fetch: fetchFake as never, apiKey: async () => "k" }));
    expect(allowed.models).toMatchObject([{ visible: true, state: "available" }]);
  });

  it("OpenRouter: no credit left is limit-zero, and at most 10 candidates are asked about", async () => {
    const fetchFake = vi.fn(async (url: string) => (url.endsWith("/key") ? json(200, { data: { limit_remaining: 0 } }) : json(200, { data: { endpoints: [{ tag: "anthropic" }] } })));
    const many = Array.from({ length: 14 }, (_unused, index) => `anthropic/model-${index}`);
    const report = await discoverModels({ provider: "openrouter", candidates: many }, deps({ fetch: fetchFake as never, apiKey: async () => "k" }));
    expect(report.models).toHaveLength(10);
    expect(report.models.every((row) => row.state === "limit-zero")).toBe(true);
    expect(fetchFake.mock.calls.filter((call) => !String(call[0]).endsWith("/key"))).toHaveLength(10);
  });
});

describe("bounds (test 28)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a hanging call is unreachable at 10 seconds", async () => {
    vi.useFakeTimers();
    const hanging = bedrockFake({ listInferenceProfiles: () => new Promise<never>(() => undefined) });
    const pending = discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, { now: () => Date.now(), bedrock: hanging });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toMatchObject({ status: "unverified", unverifiedReason: "unreachable" });
  });

  it("the whole discovery stops at 60 seconds even when every call answers just in time", async () => {
    let clock = NOW;
    const slow = bedrockFake({ listInferenceProfiles: async () => { clock += 61_000; return { profiles: [], nextToken: "more" }; } });
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, { now: () => clock, bedrock: slow });
    expect(report).toMatchObject({ status: "unverified", unverifiedReason: "unreachable" });
  });

  it("the page caps hold: 5 profile pages, 20 quota pages, 20 availability checks", async () => {
    let profilePages = 0; let quotaPages = 0; let checks = 0;
    const many = Array.from({ length: 30 }, (_unused, index) => `us.vendor.model-${index}`);
    const client: BedrockDiscoveryClient = {
      listInferenceProfiles: async () => { profilePages += 1; return { profiles: many.map((id) => ({ id, status: "ACTIVE", foundationModelIds: [`vendor.model-${id.slice(16)}`] })), nextToken: "more" }; },
      listFoundationModels: async () => [],
      getAvailability: async () => { checks += 1; return { agreement: "AVAILABLE", authorization: "AUTHORIZED" }; },
    };
    const quotas: QuotaClient = { list: async () => { quotaPages += 1; return { quotas: [], nextToken: "more" }; } };
    const report = await discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates: many }, deps({ bedrock: client, quotas }));
    expect(report.status).toBe("listed");
    expect([profilePages, quotaPages, checks]).toEqual([5, 20, 20]);
    // The ones past the 20 checks are listed, not claimed available.
    expect(report.models.filter((row) => row.state === "available")).toHaveLength(20);
    expect(report.models.filter((row) => row.state === "listed")).toHaveLength(10);
  });
});

describe("rankModels (test 29)", () => {
  const report = (states: Record<string, "available" | "limit-zero" | "needs-access">): ModelDiscoveryReport => ({ schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: new Date(NOW).toISOString(),
    status: "listed", models: Object.entries(states).map(([modelId, state]) => ({ modelId, visible: true, state, quotas: [], signals: [] })) });

  it("a passed driving test puts the model in Works on your account with its date, even when discovery says limit-zero", () => {
    const ranked = rankModels({ report: report({ [HAIKU_55_US]: "available", [HAIKU_45_GLOBAL]: "limit-zero", [HAIKU_45_US]: "available" }), eligible: ELIGIBLE, recommended: HAIKU_55_US,
      tests: [{ modelId: HAIKU_45_GLOBAL, outcome: "passed", payloadShape: "minimal", testedAt: "2026-10-23T10:00:00Z" }] });
    expect(ranked.worksOnAccount).toMatchObject([{ modelId: HAIKU_45_GLOBAL, testedAt: "2026-10-23T10:00:00Z", payloadShape: "minimal" }]);
    expect(ranked.notUsable.map((row) => row.modelId)).not.toContain(HAIKU_45_GLOBAL);
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
  });

  it("a failed test (key-rejected) puts that model in Not usable with its class, and the latest test wins", () => {
    const ranked = rankModels({ report: report({ [HAIKU_45_US]: "available", [HAIKU_55_US]: "available" }), eligible: ELIGIBLE, recommended: HAIKU_55_US,
      tests: [{ modelId: HAIKU_55_US, outcome: "passed", testedAt: "2026-10-22T10:00:00Z" }, { modelId: HAIKU_55_US, outcome: "failed", failureClass: "key-rejected", testedAt: "2026-10-23T10:00:00Z" }] });
    expect(ranked.notUsable).toMatchObject([{ modelId: HAIKU_55_US, reason: { code: "test-failed", failureClass: "key-rejected" } }]);
    expect(ranked.worksOnAccount).toEqual([]);
    // The default is not usable, so the recommendation moves on.
    expect(ranked.recommended?.modelId).toBe(HAIKU_45_US);
  });

  it("when the default is not usable the best model that works is recommended before an untested one", () => {
    const ranked = rankModels({ report: report({ [HAIKU_55_US]: "limit-zero", [HAIKU_45_US]: "available", [HAIKU_45_GLOBAL]: "available" }), eligible: ELIGIBLE, recommended: HAIKU_55_US,
      tests: [{ modelId: HAIKU_45_GLOBAL, outcome: "passed", testedAt: "2026-10-23T10:00:00Z" }] });
    expect(ranked.recommended?.modelId).toBe(HAIKU_45_GLOBAL);
  });

  it("Can be tested is ordered by the current setting, family, US-only before Global, price, then id", () => {
    const ranked = rankModels({ report: report({ [HAIKU_45_GLOBAL]: "available", [HAIKU_45_US]: "available", [HAIKU_55_GLOBAL]: "available", [HAIKU_55_US]: "available" }), eligible: ELIGIBLE,
      recommended: HAIKU_55_US, tests: [], current: HAIKU_45_GLOBAL });
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
    expect(ranked.canBeTested.map((row) => row.modelId)).toEqual([HAIKU_45_GLOBAL, HAIKU_45_US, HAIKU_55_GLOBAL]);
  });

  it("models that are not visible are left out", () => {
    const ranked = rankModels({ report: report({ [HAIKU_45_US]: "available" }), eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.canBeTested.map((row) => row.modelId)).toEqual([]);
    expect(ranked.recommended?.modelId).toBe(HAIKU_45_US);
  });
});

// I-3 DISCOVERQUOTA: the live run recommended us.anthropic.claude-haiku-5-5 although both of its account quotas (L-47520EB7, L-F26CA8D1) are 0. Whatever made the quota unreadable
// (the account's quota list is long, the lookup was denied or slow), a model whose quota is not known must not be recommended as usable.
describe("a quota that is zero or unknown is never recommended (I-3)", () => {
  const filler = (page: number): QuotaRow[] => Array.from({ length: 100 }, (_unused, index) => ({ code: `L-FILL-${page}-${index}`, name: `Unrelated quota ${page}-${index}`, value: 1 }));
  /** An account whose quota list is `pages` pages long; `target` rows come on page `targetPage` (1-based). */
  const longList = (pages: number, targetPage: number, target: readonly QuotaRow[] = quotaRows): QuotaClient => ({
    list: async (page) => { const index = page.nextToken === undefined ? 1 : Number(page.nextToken); return { quotas: index === targetPage ? [...filler(index), ...target] : filler(index), ...(index < pages ? { nextToken: String(index + 1) } : {}) }; },
  });
  const denied: QuotaClient = { list: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
  const discover = (quotas: QuotaClient) => discoverModels({ provider: "amazon-bedrock", region: "us-east-1", candidates }, deps({ bedrock: bedrockFake(), quotas }));

  it("finds the Haiku 5.5 quotas when they come after the tenth page of the account's list: both routes are limit-zero, not recommended", async () => {
    const report = await discover(longList(15, 13));
    const by = new Map(report.models.map((row) => [row.modelId, row] as const));
    expect(by.get(HAIKU_55_US)).toMatchObject({ state: "limit-zero" });
    expect(by.get(HAIKU_55_GLOBAL)).toMatchObject({ state: "limit-zero" });
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.notUsable.map((row) => [row.modelId, row.reason.code])).toEqual([[HAIKU_55_US, "limit-zero"], [HAIKU_55_GLOBAL, "limit-zero"]]);
    expect(ranked.recommended?.modelId).not.toBe(HAIKU_55_US);
  });

  it("a quota list that is longer than the page cap leaves the quota unknown: nothing is recommended, and the report says why", async () => {
    const report = await discover(longList(40, 38));
    const row = report.models.find((item) => item.modelId === HAIKU_55_US)!;
    expect(row.quotas.map((entry) => entry.tokensPerMinute)).toEqual([null, null]);
    expect(row.signals).toContain("quota-lookup-incomplete");
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended).toBeNull();
    expect(ranked.why).toBe("quota-unreadable");
    expect(ranked.canBeTested.every((entry) => entry.quotaUnreadable === true)).toBe(true);
    expect(ranked.canBeTested.map((entry) => entry.modelId)).toContain(HAIKU_55_US);
  });

  it("a denied quota lookup is not recommended as usable: the models stay visible as testable, with the denial as a fixed code", async () => {
    const report = await discover(denied);
    expect(report.models.find((item) => item.modelId === HAIKU_55_US)!.signals).toContain("quota-lookup-access-denied");
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended).toBeNull();
    expect(ranked.why).toBe("quota-unreadable");
    expect(ranked.notUsable).toEqual([]);
    expect(ranked.canBeTested).toHaveLength(4);
  });

  it("a report stored before this change (available, both quotas null) is read the same way", () => {
    const stored: ModelDiscoveryReport = { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: new Date(NOW).toISOString(), status: "listed", models: [
      { modelId: HAIKU_55_US, visible: true, state: "available", quotas: [{ scope: "geographic", code: "L-47520EB7", tokensPerMinute: null }, { scope: "global", code: "L-F26CA8D1", tokensPerMinute: null }], signals: [] },
      { modelId: HAIKU_45_US, visible: true, state: "available", quotas: [{ scope: "geographic", code: "L-HAIKU45GEO", tokensPerMinute: 5_000_000 }, { scope: "global", code: "L-HAIKU45GLO", tokensPerMinute: 10_000_000 }], signals: [] },
    ] };
    const ranked = rankModels({ report: stored, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended?.modelId).toBe(HAIKU_45_US);
    expect(ranked.why).toBe("quota-unreadable");
    expect(ranked.canBeTested.find((entry) => entry.modelId === HAIKU_55_US)).toMatchObject({ quotaUnreadable: true });
  });

  it("a driving test that passed still puts the model in Works, whatever the quota lookup said", async () => {
    const report = await discover(denied);
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [{ modelId: HAIKU_55_US, outcome: "passed", testedAt: "2026-10-23T10:00:00Z" }] });
    expect(ranked.worksOnAccount.map((row) => row.modelId)).toEqual([HAIKU_55_US]);
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
  });

  it("a readable quota above zero is recommended as before", async () => {
    const report = await discover(quotaFake(quotaRows.map((row) => ({ ...row, value: 4_000_000 }))));
    const ranked = rankModels({ report, eligible: ELIGIBLE, recommended: HAIKU_55_US, tests: [] });
    expect(ranked.recommended?.modelId).toBe(HAIKU_55_US);
    expect(ranked.why).toBe("default");
  });
});
