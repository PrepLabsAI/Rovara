// PRICE-BANDS (money). The setup run's spend used the gateway's signed run price per token class, but that price is the POOLED maximum over the base rate AND every long-context band, so a glm-5 run (base $1.00 in / $3.20 out,
// a 2x band above 200K input tokens per call) was shown at 2.0x its real cost although no call passed about 65K input (prod 2026-11-23: 192 / 192 / 170 cents shown, about 96 / 96 / 85 real). The gateway's quote now states the
// BASE band beside the pooled price (`runPriceBaseBand`), the signed task token carries it inside `runPrice.baseBand`, and the worker counts a call at the base band while its whole input is at most the band's limit.
// These tests pin: the prod shapes with and without the band; a call above the limit; every way the band can be missing or wrong (the pooled price, never less); and the wire both ways between old and new.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunPriceSchema, TaskTokenClaimsSchema, runPriceWithBaseBand, splitRunPriceBaseBand, type RunPrice } from "../../packages/contracts/src/index.js";
import { parseModelAccess } from "../../packages/worker/src/cx-c/model-access-response.js";
import { acceptedRunPrice } from "../../packages/worker/src/cx-c/run-price-ceiling.js";
import { runPriceReader } from "../../packages/broker/src/core-host/run-price-http.js";
import { dearestInputPerMTok, invocationModelPrice, priceForInputTokens, turnCostUsd, type ModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { SetupSpendMeter } from "../../packages/worker/src/setup-agent-spend.js";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";
import { signingWorld } from "../support/model-gateway.js";
import { runWikiBuild, type WikiRunInput, type WikiRunPorts } from "../../packages/worker/src/wiki-build-run.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";

const route = { alias: "company-alias", catalog: "zai.glm-5", api: "anthropic-messages" } as const;
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
/** glm-5 as the gateway quotes it: pooled $2.00 / $6.40 (the 2x band above 200K), cache write $4.00 (the 2x write factor on the band), no cache read; base $1.00 / $3.20 / write $2.00. */
const POOLED: RunPrice = { companyId: COMPANY, model: route.alias, provider: "bedrock", sourceId: "operator-ai", connectionRevision: "r1", catalogModel: "zai.glm-5", snapshotHash: "a".repeat(64), snapshotVersion: 7,
  inputUsdPerMillion: 2, outputUsdPerMillion: 6.4, cacheWriteUsdPerMillion: 4, cacheReadUsdPerMillion: 2, expiresAt: Date.now() + 300_000 };
const BAND = { upToInputTokens: 200_000, inputUsdPerMillion: 1, outputUsdPerMillion: 3.2, cacheWriteUsdPerMillion: 2, cacheReadUsdPerMillion: 1 };
const PRICE: ModelPrice = { inputPerMTok: 2, outputPerMTok: 6.4, cacheReadPerMTok: 2, cacheWritePerMTok: 4 };
const BANDED: ModelPrice = { ...PRICE, baseBand: { upToInputTokens: 200_000, inputPerMTok: 1, outputPerMTok: 3.2, cacheReadPerMTok: 1, cacheWritePerMTok: 2 } };

/** The prod runs of 2026-11-23 (no cache): total input and output tokens over the calls, none above about 65K input. */
const PROD = [{ name: "run 1", calls: 19, input: 952_110, output: 1_480, shown: 192, real: 96 }, { name: "run 2", calls: 21, input: 951_498, output: 1_249, shown: 192, real: 96 }, { name: "run 3", calls: 23, input: 844_840, output: 1_221, shown: 170, real: 85 }];
const assistantTurn = (usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x" }], usage } });
function runOf(price: ModelPrice, shape: typeof PROD[number]): SetupSpendMeter {
  const meter = new SetupSpendMeter(price);
  for (let i = 0; i < shape.calls; i += 1) {
    const last = i === shape.calls - 1;
    const input = Math.floor(shape.input / shape.calls) + (last ? shape.input % shape.calls : 0), output = Math.floor(shape.output / shape.calls) + (last ? shape.output % shape.calls : 0);
    expect(input).toBeLessThan(70_000);
    meter.observe(assistantTurn({ input, output }));
  }
  return meter;
}
const cents = (usd: number): number => Math.ceil(usd * 100 - 1e-9);

describe("a setup run is counted at the base band while no call reached the long band", () => {
  it.each(PROD)("prod $name: $shown cents at the pooled rates, $real cents with the base band", (shape) => {
    expect(cents(runOf(PRICE, shape).bookedUsd)).toBe(shape.shown);
    expect(cents(runOf(BANDED, shape).bookedUsd)).toBe(shape.real);
    expect(runOf(BANDED, shape).spentUsd).toBe(runOf(BANDED, shape).bookedUsd);
  });
  it("a call ABOVE the limit is counted at the pooled (long band) rates, one AT the limit at the base band's", () => {
    const at = { input: 200_000, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    expect(turnCostUsd(BANDED, at)).toBeCloseTo((200_000 * 1 + 1_000 * 3.2) / 1_000_000, 9);
    const above = { input: 200_001, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    expect(turnCostUsd(BANDED, above)).toBeCloseTo((200_001 * 2 + 1_000 * 6.4) / 1_000_000, 9);
  });
  it("the call's size is the gateway's: plain input + cache read + cache write", () => {
    // 100K plain + 100K read + 1 written is 200,001 input tokens: the long band.
    const split = { input: 100_000, cacheRead: 100_000, cacheWrite: 1, output: 0 };
    expect(turnCostUsd(BANDED, split)).toBeCloseTo((100_000 * 2 + 100_000 * 2 + 1 * 4) / 1_000_000, 9);
    const inside = { input: 100_000, cacheRead: 99_999, cacheWrite: 1, output: 0 };
    expect(turnCostUsd(BANDED, inside)).toBeCloseTo((100_000 * 1 + 99_999 * 1 + 1 * 2) / 1_000_000, 9);
  });
  it("property: the band never counts LESS than the gateway settles (base rates up to the limit, the pooled maxima above it)", () => {
    let state = 5;
    const random = () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; };
    for (let i = 0; i < 500; i += 1) {
      const tokens = { input: Math.floor(random() * 150_000), output: Math.floor(random() * 9_000), cacheRead: Math.floor(random() * 150_000), cacheWrite: Math.floor(random() * 80_000) };
      const whole = tokens.input + tokens.cacheRead + tokens.cacheWrite;
      const settled = whole <= 200_000
        ? (tokens.input * 1 + tokens.output * 3.2 + tokens.cacheRead * 1 + tokens.cacheWrite * 2) / 1_000_000
        : (tokens.input * 2 + tokens.output * 6.4 + tokens.cacheRead * 2 + tokens.cacheWrite * 4) / 1_000_000;
      expect(turnCostUsd(BANDED, tokens)).toBeGreaterThanOrEqual(settled - 1e-12);
    }
  });
});

describe("the pooled price stays the answer whenever the band is absent, unusable or inconsistent (never under-counted)", () => {
  const turn = { input: 60_000, output: 500, cacheRead: 0, cacheWrite: 0 };
  const pooledCost = turnCostUsd(PRICE, turn);
  it("the pinned 2.0x stays true for a run price without a band (an older gateway)", () => {
    expect(pooledCost).toBeCloseTo((60_000 * 2 + 500 * 6.4) / 1_000_000, 9);
    expect(priceForInputTokens(PRICE, 60_000)).toEqual(PRICE);
  });
  it.each([
    ["a base rate above the pooled rate", { ...BANDED.baseBand!, inputPerMTok: 2.5 }], ["a dearer output", { ...BANDED.baseBand!, outputPerMTok: 7 }], ["a dearer cache read", { ...BANDED.baseBand!, cacheReadPerMTok: 3 }],
    ["a dearer cache write", { ...BANDED.baseBand!, cacheWritePerMTok: 5 }], ["a zero limit", { ...BANDED.baseBand!, upToInputTokens: 0 }], ["a negative limit", { ...BANDED.baseBand!, upToInputTokens: -5 }],
    ["a fractional limit", { ...BANDED.baseBand!, upToInputTokens: 10.5 }], ["a NaN rate", { ...BANDED.baseBand!, inputPerMTok: Number.NaN }], ["a negative rate", { ...BANDED.baseBand!, outputPerMTok: -1 }],
  ])("%s: the band is ignored", (_name, baseBand) => {
    expect(turnCostUsd({ ...PRICE, baseBand }, turn)).toBeCloseTo(pooledCost, 12);
    expect(dearestInputPerMTok({ ...PRICE, baseBand }, 60_000)).toBe(dearestInputPerMTok(PRICE));
  });
  it("a size that is not a number (NaN) is never inside the band", () => {
    expect(priceForInputTokens(BANDED, Number.NaN)).toEqual(PRICE);
  });
});

describe("the next-turn reserve follows the same band", () => {
  it("inside the band the reserve is at the base rates (exactly); a context past the limit is at the pooled rates", () => {
    // First turn: 20,000 + 0 + 1,024 = 21,024 input tokens and the 8,192 output cap. Base: 21,024 x max(1, 1, 2) + 8,192 x 3.2 = 6.82 cents -> 7. Pooled: 21,024 x max(2, 2, 4) + 8,192 x 6.4 = 13.65 -> 14.
    expect(new SetupSpendMeter(BANDED).reserveCents()).toBe(7);
    expect(new SetupSpendMeter(PRICE).reserveCents()).toBe(14);
    // A last context of 199,000 plus the output and 1,024 margin is 200,024: above the limit, so at the pooled rates.
    const big = new SetupSpendMeter(BANDED), bigPooled = new SetupSpendMeter(PRICE);
    big.observe(assistantTurn({ input: 199_000, output: 0 })); bigPooled.observe(assistantTurn({ input: 199_000, output: 0 }));
    expect(big.reserveCents()).toBe(bigPooled.reserveCents());
  });
  it("the stand-in writer's ceiling and a call with no size stay at the pooled maximum", () => {
    expect(dearestInputPerMTok(BANDED)).toBe(dearestInputPerMTok(PRICE));
    expect(dearestInputPerMTok(BANDED, 10_000)).toBe(2);
  });
});

describe("the contract: a base band is optional and inside the pooled run price", () => {
  it("accepts a run price with or without the band, in a task token claim too", () => {
    expect(RunPriceSchema.safeParse(POOLED).success).toBe(true);
    expect(RunPriceSchema.safeParse({ ...POOLED, baseBand: BAND }).success).toBe(true);
    const claims = { iss: "https://install.example/v1/auth", aud: "rovara-model-gateway", jti: "11111111-1111-4111-8111-111111111111", iat: 1, nbf: 1, exp: 900, cid: COMPANY, pid: "web", pay: { kind: "project", project: "web" },
      tid: "t", ws: "22222222-2222-4222-8222-222222222222", op: "33333333-3333-4333-8333-333333333333", stp: "build", mdl: [route.alias] };
    expect(TaskTokenClaimsSchema.safeParse({ ...claims, runPrice: { ...POOLED, baseBand: BAND } }).success).toBe(true);
    expect(TaskTokenClaimsSchema.safeParse({ ...claims, runPrice: POOLED }).success).toBe(true);
  });
  it.each([{ ...BAND, inputUsdPerMillion: 2.01 }, { ...BAND, outputUsdPerMillion: 6.5 }, { ...BAND, cacheWriteUsdPerMillion: 4.5 }, { ...BAND, cacheReadUsdPerMillion: 2.5 }, { ...BAND, upToInputTokens: 0 }, { ...BAND, extra: 1 }, { ...BAND, inputUsdPerMillion: 0 }, "x", null])("refuses %j", (band) => {
    expect(RunPriceSchema.safeParse({ ...POOLED, baseBand: band }).success).toBe(false);
  });
  it("runPriceWithBaseBand leaves the pooled price alone for a band that is absent, malformed or dearer", () => {
    expect(runPriceWithBaseBand(POOLED, undefined)).toEqual(POOLED);
    expect(runPriceWithBaseBand(POOLED, { ...BAND, inputUsdPerMillion: 9 })).toEqual(POOLED);
    expect(runPriceWithBaseBand(POOLED, "junk")).toEqual(POOLED);
    expect(runPriceWithBaseBand(POOLED, BAND)).toEqual({ ...POOLED, baseBand: BAND });
  });
});

describe("old and new, both ways", () => {
  // What a worker built before this change parses: the 13-field strict object.
  const OldRunPrice = z.object({ companyId: z.string(), model: z.string(), provider: z.string(), sourceId: z.string(), connectionRevision: z.string(), catalogModel: z.string(), snapshotHash: z.string(), snapshotVersion: z.number(),
    expiresAt: z.number(), inputUsdPerMillion: z.number(), outputUsdPerMillion: z.number(), cacheWriteUsdPerMillion: z.number(), cacheReadUsdPerMillion: z.number() }).strict();
  const access = (extra: Record<string, unknown>) => ({ baseUrl: "https://gateway.example", apiKey: "fixture-key", expiresAt: Date.now() + 900_000, ...extra });

  it("new broker -> old worker: the answer's runPrice keeps its old strict shape, the band is a sibling", () => {
    const wire = JSON.parse(JSON.stringify(splitRunPriceBaseBand({ ...POOLED, baseBand: BAND }))) as { runPrice: unknown; runPriceBaseBand?: unknown };
    expect(OldRunPrice.safeParse(wire.runPrice).success).toBe(true);
    expect(wire.runPriceBaseBand).toEqual(BAND);
    expect(splitRunPriceBaseBand(POOLED)).toEqual({ runPrice: POOLED });
  });
  it("new broker -> new worker: the band arrives with the price; an old broker's answer (no sibling) parses as the pooled price", () => {
    const wire = JSON.parse(JSON.stringify(splitRunPriceBaseBand({ ...POOLED, baseBand: BAND }))) as Record<string, unknown>;
    expect(parseModelAccess(access(wire)).runPrice).toEqual({ ...POOLED, baseBand: BAND });
    expect(parseModelAccess(access({ runPrice: POOLED })).runPrice).toEqual(POOLED);
  });
  it("a sibling band that is dearer than the pooled price, malformed, or with no runPrice at all, never reaches the worker's price", () => {
    expect(parseModelAccess(access({ runPrice: POOLED, runPriceBaseBand: { ...BAND, inputUsdPerMillion: 3 } })).runPrice).toEqual(POOLED);
    expect(parseModelAccess(access({ runPrice: POOLED, runPriceBaseBand: "x" })).runPrice).toEqual(POOLED);
    expect(parseModelAccess(access({ runPriceBaseBand: BAND })).runPrice).toBeUndefined();
  });
  it("the worker prices the run from the answer: banded with the band, 2.0x without it", async () => {
    const proxy = (body: unknown) => operationModelProxy({ payload: { modelRoute: route, workflowMode: "WIKI_BUILD" }, controlPlaneUrl: "https://broker.example", capability: "fixture", proxyUrl: undefined, fetch: async () => Response.json(body) })!;
    const with_ = await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, proxy(access(splitRunPriceBaseBand({ ...POOLED, baseBand: BAND }))));
    expect(with_).toEqual({ inputPerMTok: 2, outputPerMTok: 6.4, cacheReadPerMTok: 2, cacheWritePerMTok: 4, baseBand: { upToInputTokens: 200_000, inputPerMTok: 1, outputPerMTok: 3.2, cacheReadPerMTok: 1, cacheWritePerMTok: 2 } });
    const without = await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, proxy(access({ runPrice: POOLED })));
    expect(without).toEqual({ inputPerMTok: 2, outputPerMTok: 6.4, cacheReadPerMTok: 2, cacheWritePerMTok: 4 });
    expect(cents(turnCostUsd(with_!, { input: 50_000, output: 80, cacheRead: 0, cacheWrite: 0 }))).toBe(6);
    expect(cents(turnCostUsd(without!, { input: 50_000, output: 80, cacheRead: 0, cacheWrite: 0 }))).toBe(11);
  });

  async function quoted(body: unknown) {
    const signed = signingWorld();
    const read = runPriceReader({ gatewayUrl: "https://gateway.example", issuer: "https://install.example/v1/auth", signer: signed.signer, fetch: async () => Response.json(body) });
    return read(COMPANY, route.alias);
  }
  it("the broker folds the quote's sibling band into the price it mints; old Cloud (no sibling) and a bad band give the pooled price", async () => {
    expect(await quoted({ state: "available", runPrice: POOLED, runPriceBaseBand: BAND })).toEqual({ ...POOLED, baseBand: BAND });
    expect(await quoted({ state: "available", runPrice: POOLED })).toEqual(POOLED);
    expect(await quoted({ state: "available", runPrice: POOLED, runPriceBaseBand: { ...BAND, outputUsdPerMillion: 7 } })).toEqual(POOLED);
    expect(await quoted({ state: "available", runPrice: POOLED, runPriceBaseBand: { ...BAND, extra: true } })).toEqual(POOLED);
  });
});

describe("a renewed quote keeps the first accepted price as its ceiling, and the band only while it still holds", () => {
  const now = () => Date.now();
  const first: RunPrice = { ...POOLED, baseBand: BAND };
  const renewed = (band: Record<string, number> | undefined): RunPrice => ({ ...POOLED, expiresAt: Date.now() + 600_000, ...(band === undefined ? {} : { baseBand: { ...BAND, ...band } }) });
  it("the same or a cheaper band keeps the ceiling's band", () => {
    expect(acceptedRunPrice(renewed({}), undefined, first, now)?.baseBand).toEqual(BAND);
    expect(acceptedRunPrice(renewed({ inputUsdPerMillion: 0.9, upToInputTokens: 250_000 }), undefined, first, now)?.baseBand).toEqual(BAND);
  });
  it.each([["a dearer base rate", { inputUsdPerMillion: 1.5 }], ["a long band that now starts sooner", { upToInputTokens: 128_000 }]])("%s drops the band: the pooled ceiling alone", (_name, change) => {
    const accepted = acceptedRunPrice(renewed(change), undefined, first, now)!;
    expect(accepted.baseBand).toBeUndefined();
    expect(accepted.inputUsdPerMillion).toBe(2);
  });
  it("a renewed quote with no band at all drops the ceiling's band; a first quote keeps its own", () => {
    expect(acceptedRunPrice(renewed(undefined), undefined, first, now)?.baseBand).toBeUndefined();
    expect(acceptedRunPrice({ ...first, expiresAt: Date.now() + 600_000 }, undefined, undefined, now)?.baseBand).toEqual(BAND);
  });
});

describe("the wiki build counts and stops at the same band", () => {
  const PAGE = "```json\n{\"pageId\":\"overview\",\"sections\":[{\"heading\":\"Start\",\"claims\":[]}]}\n```";
  /** The failure word the page was sent back with (undefined: the page was written). */
  async function failureOf(price: ModelPrice, spendCeilingCents: number): Promise<string | undefined> {
    const sent: Array<{ kind: string; answer?: { failure?: string } }> = [];
    await build(price, spendCeilingCents, sent);
    return sent.find((body) => body.kind === "page")?.answer?.failure;
  }
  async function build(price: ModelPrice, spendCeilingCents: number, sent: unknown[] = []) {
    const listeners: Array<(event: unknown) => void> = [];
    const session = { conversationId: "c", sessionFile: "f", prompt: async () => { for (const l of listeners) { l({ type: "turn_start" }); l({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: PAGE }], usage: { input: 1_000, cacheRead: 0, cacheWrite: 100_000, output: 1_000 } } }); } },
      abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0 }) as never, subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined } as PiSessionHandle;
    const queue: unknown[] = [{ kind: "page", page: { id: "overview", kind: "overview" }, pins: [{ repo: "api", commit: "a".repeat(40) }], instructions: "Write overview.", spendCeilingCents }];
    const ports: WikiRunPorts = {
      openSession: async () => session, callback: async (body) => { sent.push(body); return (body as { kind: string }).kind === "next" ? (queue.shift() ?? { kind: "end", word: "built" }) : { pageId: "x", kept: true, claimsKept: 0, claimsDropped: 0, complete: true }; },
      progress: async () => undefined, register: () => () => undefined, repositoryReadable: async () => true,
    };
    const input: WikiRunInput = { rootPath: "/work", operationId: "op-1", limits: { pages: 10, budgetCents: 5_000, wallClockMin: 60, pageReserveCents: 100 }, pins: [{ repo: "api", commit: "a".repeat(40) }], repositories: [{ name: "api", path: "repo/api", resolvedCommit: "a".repeat(40) }], price, ports };
    return runWikiBuild(input);
  }
  it("REVIEW (Opus): the reserve counts the tool results since the last turn when it picks the band (150K context + 2 tool results crosses 200K: pooled)", async () => {
    // One turn: 150,000 plain input + 1,000 output = 16 cents at the band. Then two tool runs: the next call may be 150,000 + 1,000 + 1,024 + 2 x 26,000 = 204,024 tokens, past the 200K limit,
    // so its reserve is at the POOLED rates (82 + 6 = 88 cents) and a ceiling of 80 stops the page. Bounding it at the band (152,024 tokens: 31 + 3 cents) would let it go on.
    const sent: Array<{ kind: string; answer?: { failure?: string } }> = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = { conversationId: "c", sessionFile: "f", prompt: async () => { for (const l of listeners) { l({ type: "turn_start" }); l({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: PAGE }], usage: { input: 150_000, cacheRead: 0, cacheWrite: 0, output: 1_000 } } }); l({ type: "tool_execution_end" }); l({ type: "tool_execution_end" }); } },
      abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0 }) as never, subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined } as PiSessionHandle;
    const queue: unknown[] = [{ kind: "page", page: { id: "overview", kind: "overview" }, pins: [{ repo: "api", commit: "a".repeat(40) }], instructions: "Write overview.", spendCeilingCents: 80 }];
    const ports: WikiRunPorts = {
      openSession: async () => session, callback: async (body) => { sent.push(body as never); return (body as { kind: string }).kind === "next" ? (queue.shift() ?? { kind: "end", word: "built" }) : { pageId: "x", kept: true, claimsKept: 0, claimsDropped: 0, complete: true }; },
      progress: async () => undefined, register: () => () => undefined, repositoryReadable: async () => true,
    };
    await runWikiBuild({ rootPath: "/work", operationId: "op-1", limits: { pages: 10, budgetCents: 5_000, wallClockMin: 60, pageReserveCents: 100 }, pins: [{ repo: "api", commit: "a".repeat(40) }], repositories: [{ name: "api", path: "repo/api", resolvedCommit: "a".repeat(40) }], price: BANDED, ports });
    expect(sent.find((body) => body.kind === "page")?.answer?.failure).toBe("budget_used");
  });
  it("a page of 1,000 plain + 100,000 written + 1,000 output tokens: 21 cents at the band, 41 at the pooled rates", async () => {
    expect((await build(BANDED, 5_000)).spentCents).toBeGreaterThanOrEqual(21);
    expect((await build(BANDED, 5_000)).spentCents).toBeLessThan(22);
    expect((await build(PRICE, 5_000)).spentCents).toBeGreaterThanOrEqual(41);
  });
  it("its next-turn reserve is at the band too: a ceiling of 60 cents holds at the band (21 + a 24 cent reserve) and stops at the pooled rates (41 + 47)", async () => {
    expect(await failureOf(BANDED, 60)).toBeUndefined();
    expect(await failureOf(PRICE, 60)).toBe("budget_used");
  });
});
