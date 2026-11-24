// CACHE-RATES (money). Staging 2026-11-23, Code 0.5.47: a setup run on Bedrock Haiku 4.5 (tokens in 349 / out 6,121 / cache read 266,037 / cache write 15,952) was SHOWN 73 cents and booked $0.72 while the gateway
// settled about $0.098 (7.4x). The signed run price carries cache rates, but they are the POOLED maxima over the base band and the cautious unknown-long band (2x above 200K): cache read $2.20 against a real $0.11.
// The signed BASE band (PRICE-BANDS) carries the real cache read and write rates; a call inside it is counted at them. This file runs the exact staging run through the real wire (the gateway's quote -> the broker's
// signed price -> the worker's `invocationModelPrice` -> `SetupSpendMeter`) and pins that it counts the gateway's settle, call by call, rounded UP to a whole micro as the gateway rounds a call (never under).
// The Cloud side of the same figures: Cloud `tests/unit/model-gateway-cache-rates.test.ts` (the real quote and `settleChargeAmount`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitRunPriceBaseBand, type RunPrice } from "../../packages/contracts/src/index.js";
import { invocationModelPrice, turnCostUsd, type ModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { SetupSpendMeter } from "../../packages/worker/src/setup-agent-spend.js";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";

const route = { alias: "company-alias", catalog: "us.anthropic.claude-haiku-4-5-20251001-v1:0", api: "anthropic-messages" } as const;
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
/** What the Cloud quote returns for Haiku 4.5 on Bedrock ($1.10 / $5.50 / read $0.11 / write $1.375 five minutes, $2.20 one hour; Cloud test pins these figures): pooled over the cautious 200K band, and the base band. */
const POOLED: RunPrice = { companyId: COMPANY, model: route.alias, provider: "bedrock", sourceId: "operator-ai", connectionRevision: "r1", catalogModel: route.catalog, snapshotHash: "a".repeat(64), snapshotVersion: 9,
  inputUsdPerMillion: 2.2, outputUsdPerMillion: 11, cacheWriteUsdPerMillion: 4.4, cacheReadUsdPerMillion: 2.2, expiresAt: Date.now() + 300_000 };
const BAND = { upToInputTokens: 200_000, inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5, cacheWriteUsdPerMillion: 2.2, cacheReadUsdPerMillion: 0.11 };
const GATEWAY_MICROS = { input: 1_100_000n, output: 5_500_000n, cacheRead: 110_000n, cacheWrite1h: 2_200_000n };

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
const TOTAL: Usage = { input: 349, output: 6_121, cacheRead: 266_037, cacheWrite: 15_952 };
function split(total: number, seed: number, calls: number): number[] {
  let state = seed;
  const weights = Array.from({ length: calls }, () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return 1 + state / 4_294_967_296; });
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[calls - 1]! += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}
/** The same deterministic split as the Cloud test (so the same 98,416 figure). */
function stagingCalls(calls = 15, seed = 0): Usage[] {
  const input = split(TOTAL.input, 1 + seed, calls), output = split(TOTAL.output, 2 + seed, calls), read = split(TOTAL.cacheRead, 3 + seed, calls), write = split(TOTAL.cacheWrite, 4 + seed, calls);
  return input.map((_, i) => ({ input: input[i]!, output: output[i]!, cacheRead: read[i]!, cacheWrite: write[i]! }));
}
/** What the gateway settles one call at (Cloud `usageCost` + `roundedCost`: exact integer arithmetic, rounded up to a micro, at least 1; every write here is a 1 hour write). */
const gatewayMicros = (u: Usage): number => {
  const numerator = BigInt(u.input) * GATEWAY_MICROS.input + BigInt(u.output) * GATEWAY_MICROS.output + BigInt(u.cacheRead) * GATEWAY_MICROS.cacheRead + BigInt(u.cacheWrite) * GATEWAY_MICROS.cacheWrite1h;
  return Math.max(1, Number((numerator + 999_999n) / 1_000_000n));
};
const micros = (usd: number): number => Math.round(usd * 1_000_000);
const assistantTurn = (usage: Partial<Usage>) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x" }], usage } });
const access = (extra: Record<string, unknown>) => ({ baseUrl: "https://gateway.example", apiKey: "fixture-key", expiresAt: Date.now() + 900_000, ...extra });
async function priceFromWire(price: RunPrice): Promise<ModelPrice> {
  const proxy = operationModelProxy({ payload: { modelRoute: route, workflowMode: "WIKI_BUILD" }, controlPlaneUrl: "https://broker.example", capability: "fixture",
    proxyUrl: undefined, fetch: async () => Response.json(access(splitRunPriceBaseBand(price))) })!;
  return (await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, proxy))!;
}
function count(price: ModelPrice, calls: Usage[]): { micros: number; cents: number } {
  const meter = new SetupSpendMeter(price);
  for (const call of calls) meter.observe(assistantTurn(call));
  return { micros: micros(meter.bookedUsd), cents: Math.ceil(meter.bookedUsd * 100 - 1e-9) };
}

describe("the staging Haiku 4.5 run (tokens in 349 / out 6,121 / cache read 266,037 / cache write 15,952)", () => {
  it("counts about $0.098 with the signed base band: exactly the gateway's settle of this split, 98,416 micros", async () => {
    const price = await priceFromWire({ ...POOLED, baseBand: BAND });
    expect(price.baseBand).toEqual({ upToInputTokens: 200_000, inputPerMTok: 1.1, outputPerMTok: 5.5, cacheReadPerMTok: 0.11, cacheWritePerMTok: 2.2 });
    const calls = stagingCalls();
    const settled = calls.reduce((sum, call) => sum + gatewayMicros(call), 0);
    expect(settled).toBe(98_416);
    const counted = count(price, calls);
    expect(counted.micros).toBe(settled);
    expect(counted.cents).toBe(10);
    // Staging's own figure of the same run (98,422: its own call split) is inside what any split of it settles at: the exact 98,407.9 micros plus at most a micro a call.
    expect(98_422).toBeGreaterThanOrEqual(98_408); expect(98_422).toBeLessThanOrEqual(98_408 + 15);
  });
  it("without the band (an older gateway or broker) it is still counted at the pooled maxima: the pinned 2.0x pooled shape, 73 cents as staging showed", async () => {
    const price = await priceFromWire(POOLED);
    expect(price.baseBand).toBeUndefined();
    expect(count(price, stagingCalls()).cents).toBe(73);
  });
  it("NEVER below the gateway's settle: any split of the run (10 to 40 calls, 20 seeds), call by call", async () => {
    const price = await priceFromWire({ ...POOLED, baseBand: BAND });
    for (let seed = 0; seed < 20; seed += 1) for (const calls of [10, 15, 25, 40]) {
      let settled = 0, counted = 0;
      for (const call of stagingCalls(calls, seed)) {
        expect(micros(turnCostUsd(price, call)), JSON.stringify(call)).toBeGreaterThanOrEqual(gatewayMicros(call));
        settled += gatewayMicros(call); counted += micros(turnCostUsd(price, call));
      }
      expect(counted).toBe(settled);
      expect(settled).toBeGreaterThanOrEqual(98_408); expect(settled).toBeLessThanOrEqual(98_408 + calls);
    }
  });
  it("a call is counted up to the next micro, as the gateway settles it (a call of one plain token at $1.10 per million is 2 micros, not 1.1)", () => {
    const price: ModelPrice = { inputPerMTok: 2.2, outputPerMTok: 11, cacheReadPerMTok: 2.2, cacheWritePerMTok: 4.4, baseBand: { upToInputTokens: 200_000, inputPerMTok: 1.1, outputPerMTok: 5.5, cacheReadPerMTok: 0.11, cacheWritePerMTok: 2.2 } };
    expect(micros(turnCostUsd(price, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBe(2);
    expect(micros(turnCostUsd(price, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBe(11);
    // A whole number of micros is not pushed up by float noise (90 x 1.1 is 99.00000000000001 in floating point, and the gateway settles exactly 99).
    expect(90 * 1.1).toBeGreaterThan(99);
    expect(micros(turnCostUsd(price, { input: 90, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBe(99);
    expect(turnCostUsd(price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    // A call with usage is at least a micro, as the gateway's `Math.max(1, ...)`.
    expect(micros(turnCostUsd({ ...price, baseBand: undefined as never, cacheReadPerMTok: 0 }, { input: 0, output: 0, cacheRead: 5, cacheWrite: 0 }))).toBe(1);
  });
  it("a missing cache rate is today's safe fallback, unchanged (read at the input rate, write at twice it)", () => {
    const noCache: ModelPrice = { inputPerMTok: 1, outputPerMTok: 5 };
    expect(turnCostUsd(noCache, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBe(3);
    expect(turnCostUsd(noCache, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(6);
  });
  it("no model-name rule anywhere in the money path (code with comments removed names no model or vendor)", () => {
    const root = new URL("../../packages/worker/src/", import.meta.url);
    for (const file of ["setup-agent-price.ts", "setup-agent-spend.ts", "wiki-build-run.ts", "cx-c/model-access-response.ts", "cx-c/run-price-ceiling.ts"]) {
      const code = readFileSync(new URL(file, root), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(/\s\/\/ .*$/gmu, "");
      expect(code, file).not.toMatch(/haiku|sonnet|opus|fable|claude|anthropic|glm|gemini|gpt/iu);
    }
  });
});
