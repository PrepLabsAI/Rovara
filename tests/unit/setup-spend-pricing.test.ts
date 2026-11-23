// Setup spend pricing (money). A setup run's own spend and its stop used one flattened input rate for every input-side token (a cache read was charged at the cache WRITE rate, plus another quarter on writes), so a cache-heavy
// run was counted 4x to 9x above what the gateway settles and stopped at "reached its spending limit" with most of the budget unspent. These tests pin: every token class priced at its own rate and never below the gateway;
// a rate the source does not carry falls back upward; the reserve stays a worst case; a failed turn with no usage is counted; the same pricing runs the stand-in writer and the wiki build; and the run's spend is booked
// through the existing usage path once, so the Work card reads the cost.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, standInWriterCeilingCents, type OrgId } from "../../packages/contracts/src/index.js";
import { budgetExhaustedMarker } from "../../packages/model-runtime/src/budget.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createHostedLedger, createHostedMetering } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { readTaskMoney } from "../../packages/broker/src/core/cost/task-money.js";
import { taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dearestInputPerMTok, priceRatesOf, turnCostUsd, type ModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { runSetupAgent, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import { writerUsagePayload } from "../../packages/worker/src/setup-agent-spend.js";
import { runStandInWriter, standInCeilingPrice } from "../../packages/worker/src/standin-writer.js";
import { runWikiBuild, type WikiRunInput, type WikiRunPorts } from "../../packages/worker/src/wiki-build-run.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "a".repeat(40);
const OPERATION = "11111111-1111-4111-8111-111111111111";
/** The gateway's run price for an Anthropic-class model: input 3, output 15, cache read 0.3, and the 1 hour write bound 6 (the 5 minute write is 3.75). */
const GATEWAY: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 6 };
/** The prod shape: per turn, in tokens. */
const PROD_TURN = { input: 2_000, cacheRead: 90_000, cacheWrite: 4_000, output: 1_000 };
/** What the gateway really settles for that turn when the write was a 5 minute write. */
const PROD_SETTLE_USD = (2_000 * 3 + 1_000 * 15 + 90_000 * 0.3 + 4_000 * 3.75) / 1_000_000;

// ---- a tiny deterministic random source, so the property cases are the same on every run
function lcg(seed: number): () => number { let state = seed; return () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; }; }

describe("pricing a turn: every token class at its own rate", () => {
  it("prices the prod shape per class (about 12% over the gateway's 5 minute figure, which is the 1 hour write bound), not at the cache write rate for the whole context", () => {
    const own = turnCostUsd(GATEWAY, PROD_TURN);
    expect(own).toBeCloseTo(0.072, 6);
    expect(own).toBeGreaterThanOrEqual(PROD_SETTLE_USD);
    expect(own / PROD_SETTLE_USD).toBeLessThan(1.2);
    // The old arithmetic: one input rate = max(input, read, write) for read + write + input tokens, plus a quarter more on writes.
    const old = ((2_000 + 90_000 + 4_000 + 4_000 * 0.25) * 6 + 1_000 * 15) / 1_000_000;
    expect(old / PROD_SETTLE_USD).toBeGreaterThan(9);
  });

  it("a cache rate the source gave is used as given, a cache read of 0 included", () => {
    expect(priceRatesOf({ inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0, cacheWritePerMTok: 4 })).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 4 });
  });

  it("a model with no cache rates is priced so it never under-counts: a read at the input rate, a write at twice the input rate", () => {
    const bare: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };
    expect(priceRatesOf(bare)).toEqual({ input: 10, output: 50, cacheRead: 10, cacheWrite: 20 });
    expect(dearestInputPerMTok(bare)).toBe(20);
    expect(turnCostUsd(bare, { input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 })).toBeCloseTo(1, 9);
    expect(turnCostUsd(bare, { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 })).toBeCloseTo(2, 9);
  });

  it("property: with no cache rates the figure is never below what any provider rate up to read = input and 1 hour write = 2 x input could charge", () => {
    const random = lcg(7);
    for (let i = 0; i < 500; i += 1) {
      const price: ModelPrice = { inputPerMTok: 0.1 + random() * 20, outputPerMTok: 0.1 + random() * 100 };
      const tokens = { input: Math.floor(random() * 300_000), output: Math.floor(random() * 20_000), cacheRead: Math.floor(random() * 300_000), cacheWrite: Math.floor(random() * 300_000) };
      const provider = { read: price.inputPerMTok * random(), write: price.inputPerMTok * (1 + random()) };
      const settled = (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok + tokens.cacheRead * provider.read + tokens.cacheWrite * provider.write) / 1_000_000;
      expect(turnCostUsd(price, tokens)).toBeGreaterThanOrEqual(settled - 1e-12);
    }
  });

  it("property: at the run price (per-component maxima over the gateway's context tiers) the figure is never below the gateway's settle of any tier, a turn over 200K context included", () => {
    const base = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const long = { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 };
    const maxima: ModelPrice = { inputPerMTok: 6, outputPerMTok: 22.5, cacheReadPerMTok: 0.6, cacheWritePerMTok: 7.5 };
    const random = lcg(11);
    let sawLong = false;
    for (let i = 0; i < 500; i += 1) {
      const tokens = { input: Math.floor(random() * 120_000), output: Math.floor(random() * 20_000), cacheRead: Math.floor(random() * 400_000), cacheWrite: Math.floor(random() * 120_000) };
      const tier = tokens.input + tokens.cacheRead + tokens.cacheWrite > 200_000 ? long : base;
      sawLong ||= tier === long;
      const settled = (tokens.input * tier.input + tokens.output * tier.output + tokens.cacheRead * tier.cacheRead + tokens.cacheWrite * tier.cacheWrite) / 1_000_000;
      expect(turnCostUsd(maxima, tokens)).toBeGreaterThanOrEqual(settled - 1e-12);
    }
    expect(sawLong).toBe(true);
  });

  it("no worker code imports the old flattened-rate constant (every price goes through turnCostUsd)", async () => {
    const dir = join(process.cwd(), "packages/worker/src");
    const files: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(path, entry.name)); else if (entry.name.endsWith(".ts")) files.push(join(path, entry.name));
      }
    };
    await walk(dir);
    for (const file of files) expect(await readFile(file, "utf8"), file).not.toMatch(/SETUP_CACHE_WRITE_EXTRA|[^_A-Z]CACHE_WRITE_EXTRA/u);
  });
});

// ---- a setup run on a scripted session
/** `empty`: the call failed before any reply streamed (a 429, an overload, `fetch failed`, a gateway refusal): no content and no stream. */
interface Turn { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string; errorMessage?: string; empty?: boolean }

async function world(options: { turns: Turn[]; price: ModelPrice; budgetCents?: number; reportedCost?: number; reports?: boolean }) {
  const rootPath = await mkdtemp(join(tmpdir(), "setup-spend-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const listeners: Array<(event: unknown) => void> = [];
  const reports: Array<Record<string, unknown>> = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let aborted = false;
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f",
    prompt: async () => {
      for (const turn of options.turns) {
        if (aborted) break;
        const usage = turn.usage;
        if (usage !== undefined) { tokens.input += usage.input ?? 0; tokens.output += usage.output ?? 0; tokens.cacheRead += usage.cacheRead ?? 0; tokens.cacheWrite += usage.cacheWrite ?? 0; tokens.total += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0); }
        for (const l of listeners) l({ type: "message_end", message: { role: "assistant", stopReason: turn.stopReason ?? "stop", ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }), content: turn.empty === true ? [] : [{ type: "text", text: "no answer" }], ...(usage === undefined ? {} : { usage }) } });
      }
    },
    abort: async () => { aborted = true; },
    getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: options.reportedCost ?? 0, tokens: { ...tokens } }) as never,
    subscribe: (l) => { listeners.push(l); return () => undefined; }, dispose: () => undefined,
  };
  const base: BashOperations = { exec: async () => ({ exitCode: 0 }) };
  const network: RunNetwork = { name: "agentx-setup-0123456789ab", subnet: "x", gateway: "x", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => [], stop: async () => undefined };
  const ports: SetupRunPorts = {
    startNetwork: async () => network, createSandbox: () => ({ bashOperations: () => base, dispose: async () => undefined, fileOpsTarget: () => ({}) }) as never,
    openSession: async () => session, callback: async () => ({ hosts: [] }), progress: async () => undefined, register: () => () => undefined, checkFiles: async () => ({ ok: true }), tickMs: 50,
    beforeStart: async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set<string>()]]) }),
    ...(options.reports === false ? {} : { reportUsage: async (payload) => { reports.push(payload); } }),
  };
  const input: SetupRunInput = {
    rootPath, operationId: OPERATION, basedOnRevision: 1, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, budgetCents: options.budgetCents ?? 400 }, price: options.price,
    repositories: [{ name: "web", path: "repo/web", resolvedCommit: COMMIT }], commits: [{ repository: "web", commit: COMMIT }], ports,
  };
  return { input, reports };
}
const turns = (count: number, turn: Turn): Turn[] => Array.from({ length: count }, () => ({ ...turn, usage: { ...turn.usage } }));

describe("the run's own spend and its stop", () => {
  it("a cache-heavy run (the prod shape) is counted at the gateway's price, not 4x to 9x above it, and is not stopped at the budget", async () => {
    // 12 turns of 2K input, 90K cache read, 4K cache write and 1K output; real gateway spend about 76 cents of a $4.00 budget. The old count was about $7 and stopped the run at the first turn.
    const w = await world({ turns: turns(12, { usage: PROD_TURN }), price: GATEWAY });
    const summary = (await runSetupAgent(w.input)).setupRunSummary;
    const settled = Math.ceil(12 * PROD_SETTLE_USD * 100);
    expect(summary.stop).not.toBe("budget_used");
    expect(summary.spendCents).toBeGreaterThanOrEqual(settled);
    expect(summary.spendCents).toBeLessThanOrEqual(Math.ceil(settled * 1.2));
  });

  it("the budget stop fires at the real spend: a $1.00 budget ends the run after about 4 turns of real spend, not after the first", async () => {
    // Per turn 7.2 cents; the reserve for the next turn is 72 cents. After 3 turns 21.6 + 72 = 93.6 < 100 and after 4 turns 28.8 + 72 = 100.8 >= 100: the run stops with about 29 cents spent.
    const w = await world({ turns: turns(20, { usage: PROD_TURN }), price: GATEWAY, budgetCents: 100 });
    const summary = (await runSetupAgent(w.input)).setupRunSummary;
    expect(summary.stop).toBe("budget_used");
    expect(summary.spendCents).toBeGreaterThanOrEqual(28);
    expect(summary.spendCents).toBeLessThanOrEqual(30);
  });

  it("a model with no cache rates is never under-counted: 100K cache-read tokens at $10 are $1.00 and 100K written are $2.00", async () => {
    const bare: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };
    const read = await world({ turns: [{ usage: { cacheRead: 100_000 } }], price: bare, budgetCents: 5_000 });
    expect((await runSetupAgent(read.input)).setupRunSummary.spendCents).toBe(100);
    const write = await world({ turns: [{ usage: { cacheWrite: 100_000 } }], price: bare, budgetCents: 5_000 });
    expect((await runSetupAgent(write.input)).setupRunSummary.spendCents).toBe(200);
  });

  it("a no-cache run is priced as it always was", async () => {
    const w = await world({ turns: [{ usage: { input: 10_000, output: 1_000 } }], price: { inputPerMTok: 3, outputPerMTok: 15 } });
    // 10,000 x 3 + 1,000 x 15 = 4.5 cents, rounded up.
    expect((await runSetupAgent(w.input)).setupRunSummary.spendCents).toBe(5);
  });

  it("the next-turn reserve stays a worst case: a cold cache writes the whole context again, so a full-context write turn always fits inside it", async () => {
    // One turn read 100K from the cache and wrote 100 output tokens: spent 4 cents. The reserve is (100,000 + 100 + 1,024) x $6 + 8,192 x $15 = 72.96, so 73 cents. 4 + 73 = 77.
    const stops = await world({ turns: [{ usage: { cacheRead: 100_000, output: 100 } }], price: GATEWAY, budgetCents: 77 });
    expect((await runSetupAgent(stops.input)).setupRunSummary.stop).toBe("budget_used");
    const fits = await world({ turns: [{ usage: { cacheRead: 100_000, output: 100 } }], price: GATEWAY, budgetCents: 78 });
    expect((await runSetupAgent(fits.input)).setupRunSummary.stop).not.toBe("budget_used");
    // And that reserve really covers the dearest next turn: the whole context written at the write rate plus the output cap.
    const dearest = turnCostUsd(GATEWAY, { input: 0, cacheRead: 0, cacheWrite: 100_000 + 100 + 1_024, output: 8_192 });
    expect(Math.ceil(dearest * 100 - 1e-9)).toBeLessThanOrEqual(73);
  });

  it("a call that BEGAN streaming and failed with NO usage counts the whole reserve as spent (the gateway may have settled it)", async () => {
    const price: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };
    // The first turn's reserve: (20,000 + 0 + 1,024) x $20 + 8,192 x $50 = 83.0 cents, so 84.
    const failed = await world({ turns: [{ stopReason: "error", errorMessage: "the provider dropped the stream" }], price, budgetCents: 5_000 });
    expect((await runSetupAgent(failed.input)).setupRunSummary.spendCents).toBeGreaterThanOrEqual(84);
    const aborted = await world({ turns: [{ stopReason: "aborted" }], price, budgetCents: 5_000 });
    expect((await runSetupAgent(aborted.input)).setupRunSummary.spendCents).toBeGreaterThanOrEqual(84);
  });

  it("a call that never began (a 429, an overload, `fetch failed`, a gateway refusal) counts nothing, however often it is retried", async () => {
    const price: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };
    const before = [
      "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
      "529 overloaded_error",
      "503 service unavailable",
      "fetch failed",
      "Anthropic request failed; the provider is overloaded; wait before retrying",
      budgetExhaustedMarker("org"),
    ];
    for (const errorMessage of before) {
      const w = await world({ turns: Array.from({ length: 3 }, () => ({ stopReason: "error", errorMessage, empty: true })), price, budgetCents: 5_000, reportedCost: 0.01 });
      expect((await runSetupAgent(w.input)).setupRunSummary.spendCents, errorMessage).toBeLessThan(84);
    }
    // And a call that began and then failed adds the reserve once per attempt: three attempts are three reserves.
    const began = await world({ turns: Array.from({ length: 3 }, () => ({ stopReason: "error" as const, errorMessage: "the provider dropped the stream" })), price, budgetCents: 5_000 });
    expect((await runSetupAgent(began.input)).setupRunSummary.spendCents).toBeGreaterThanOrEqual(84);
  });

  // The three prod setup runs on glm-5 (real gateway price $1.00 in / $3.20 out per million; the run price the worker is signed is the POOLED bound over every long-context band: input $2.00, output $6.40, cache write
  // $4.00). They used no cache. The old arithmetic charged every input token at the cache write rate ($4.00): 382 / 382 / 339 cents, exactly 4.00x the real $0.957 / $0.956 / $0.849. Per-class pricing removes that 2x
  // (the input is no longer raised to the write rate), but the pooled long-context input rate still doubles it: 192 / 192 / 170 cents, 2.0x. PRICE-BANDS (a follow-up: pick the band from the call's real input size) brings it to ~1.0x.
  it.each([
    ["run 1", 952_110, 1_480, 192, 0.9569, 382],
    ["run 2", 951_498, 1_249, 192, 0.9555, 382],
    ["run 3", 844_840, 1_221, 170, 0.8487, 339],
  ])("prod glm-5 %s at the pooled signed price shows %i + %i tokens as %i cents, 2.0x the real $%s (until PRICE-BANDS)", async (_name, input, output, cents, realUsd, oldCents) => {
    const pooled: ModelPrice = { inputPerMTok: 2, outputPerMTok: 6.4, cacheReadPerMTok: 2, cacheWritePerMTok: 4 };
    const w = await world({ turns: [{ usage: { input, output } }], price: pooled, budgetCents: 5_000 });
    const shown = (await runSetupAgent(w.input)).setupRunSummary.spendCents;
    expect(shown).toBe(cents);
    expect(shown / (realUsd * 100)).toBeGreaterThan(1.95);
    expect(shown / (realUsd * 100)).toBeLessThan(2.05);
    // At the real rates the same tokens are the gateway's figure within a cent.
    const real = await world({ turns: [{ usage: { input, output } }], price: { inputPerMTok: 1, outputPerMTok: 3.2 }, budgetCents: 5_000 });
    expect(Math.abs((await runSetupAgent(real.input)).setupRunSummary.spendCents - realUsd * 100)).toBeLessThan(1);
    // The old count at $4.00 in / $6.40 out: 4.00x.
    expect(Math.ceil((input * 4 + output * 6.4) / 10_000)).toBe(oldCents);
  });

  it("a turn of cache reads only, with a cache read rate of 0 and no output, is known spend of 0, not an unreadable one", async () => {
    const free: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0, cacheWritePerMTok: 6 };
    const w = await world({ turns: [{ usage: { cacheRead: 50_000 } }], price: free });
    expect((await runSetupAgent(w.input)).setupRunSummary.stop).not.toBe("budget_used");
  });

  it("a turn with neither usage nor cost is still unreadable spend (the budget used up): the fail-closed path is unchanged", async () => {
    const w = await world({ turns: [{}], price: GATEWAY });
    expect((await runSetupAgent(w.input)).setupRunSummary.stop).toBe("budget_used");
  });
});

describe("the stand-in writer and the wiki build use the same pricing", () => {
  const ONE_HOUR_WRITE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 6 };
  it("the wiki build counts a cache write at the write rate (the old arithmetic charged 1.25 x input and under-counted a 1 hour write)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = { conversationId: "c", sessionFile: "f", prompt: async () => { for (const l of listeners) { l({ type: "turn_start" }); l({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "```json\n{\"pageId\":\"overview\",\"sections\":[{\"heading\":\"Start\",\"claims\":[]}]}\n```" }], usage: { input: 1_000, cacheRead: 0, cacheWrite: 100_000, output: 1_000 } } }); } },
      abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0 }) as never, subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined } as PiSessionHandle;
    const queue: unknown[] = [{ kind: "page", page: { id: "overview", kind: "overview" }, pins: [{ repo: "api", commit: "a".repeat(40) }], instructions: "Write overview.", spendCeilingCents: 5_000 }];
    const ports: WikiRunPorts = {
      openSession: async () => session, callback: async (body) => { calls.push(body as Record<string, unknown>); return (body as { kind: string }).kind === "next" ? (queue.shift() ?? { kind: "end", word: "built" }) : { pageId: "x", kept: true, claimsKept: 0, claimsDropped: 0, complete: true }; },
      progress: async () => undefined, register: () => () => undefined, repositoryReadable: async () => true,
    };
    const input: WikiRunInput = { rootPath: "/work", operationId: "op-1", limits: { pages: 10, budgetCents: 5_000, wallClockMin: 60, pageReserveCents: 100 }, pins: [{ repo: "api", commit: "a".repeat(40) }], repositories: [{ name: "api", path: "repo/api", resolvedCommit: "a".repeat(40) }], price: ONE_HOUR_WRITE, ports };
    const result = await runWikiBuild(input);
    // 1,000 x 3 + 100,000 x 6 + 1,000 x 15 = 0.618 dollars, so at least 62 cents (the old count: 101,000 x 3 x 1.25 ... = 0.4 dollars).
    expect(result.spentCents).toBeGreaterThanOrEqual(62);
  });

  it("the stand-in writer's cost ceiling bounds a cold-cache write at the write rate (the contract's 1.25 factor is divided out), not at 1.25 x input", () => {
    const hosted = standInWriterCeilingCents(standInCeilingPrice(ONE_HOUR_WRITE));
    const naive = standInWriterCeilingCents({ inputPerMTok: ONE_HOUR_WRITE.inputPerMTok, outputPerMTok: ONE_HOUR_WRITE.outputPerMTok });
    expect(hosted).toBeGreaterThan(naive);
    // The input part grows from 3 x 1.25 = 3.75 to exactly the write rate 6 per million: the ratio of the two input parts.
    expect(standInCeilingPrice(ONE_HOUR_WRITE).inputPerMTok * 1.25).toBeCloseTo(6, 9);
    // A model with no cache rates is priced at twice its input rate.
    expect(standInCeilingPrice({ inputPerMTok: 3, outputPerMTok: 15 }).inputPerMTok * 1.25).toBeCloseTo(6, 9);
  });

  it("the stand-in writer counts a cache write at the write rate, and hands the caller its session's usage with the cents counted", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const seen: Array<{ cents: number }> = [];
    const session = { conversationId: "w", sessionFile: "w",
      prompt: async () => { for (const l of listeners) l({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "not json" }], usage: { input: 100, cacheWrite: 50_000, output: 100 } } }); },
      abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0, tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 50_000, total: 50_200 } }) as never,
      subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined } as PiSessionHandle;
    const outcome = await runStandInWriter({
      input: { tables: [{ name: "t", rows: 1, columns: [{ name: "id", kind: "integer", key: true, writable: false }, { name: "bio", kind: "text", key: false, writable: true, maxChars: 40 }] }], operations: [] },
      price: ONE_HOUR_WRITE, remainingCents: 10_000, openSession: async () => session, onUsage: (_stats, _model, cents) => { seen.push({ cents }); },
    });
    // 100 x 3 + 50,000 x 6 + 100 x 15 = 0.3018 dollars: at least 31 cents (the old count at 1.25 x input was about 19).
    expect(outcome.spendCents).toBeGreaterThanOrEqual(31);
    expect(seen).toEqual([{ cents: outcome.spendCents }]);
  });
});

// ---- booking
const ORG = COMPANY_A_ID as OrgId;
const NOW = new Date("2026-11-23T10:00:00.000Z");
/** A catalog table that prices the model cheaper than the run's own count: the larger figure must win. */
const CHEAP = { inputMicrosPerMillionTokens: 100_000, outputMicrosPerMillionTokens: 100_000 };
const metering = createHostedMetering({ find: () => ({ price: CHEAP, currency: "USD", origin: "catalog" }), findCap: () => ({ price: CHEAP, currency: "USD", origin: "catalog" }) });

describe("booking the run's spend through the existing usage path", () => {
  async function booked(w: Awaited<ReturnType<typeof world>>, resend = 1) {
    const store = new MemoryDocumentStore();
    const booking = createUsageBooking({ store, metering, now: () => NOW });
    const taskId = randomUUID();
    const operation = { id: OPERATION, workspaceId: randomUUID(), companyId: ORG };
    await store.put({ item: { ...taskPointerKey(operation.companyId, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    // The worker's batcher stamps each event once and sends the same event again when a batch is retried.
    const events = w.reports.map((payload, index) => ({ type: "usage", timestamp: new Date(NOW.getTime() + index).toISOString(), payload }));
    for (let i = 0; i < resend; i += 1) await booking.bookOperationEvents(operation, events);
    const task = { taskId, companyId: ORG, workspaceId: operation.workspaceId, status: "CLOSED", updatedAt: NOW.toISOString(), createdAt: NOW.toISOString() };
    return { money: await readTaskMoney({ store, companyId: ORG, task, hosted: true }), ledger: createHostedLedger({ store, metering, now: () => NOW }), taskId };
  }

  it("a finished run books its spend: the Work card reads a dollar figure that is not below the run's own count, and an event sent again books nothing more", async () => {
    const w = await world({ turns: turns(12, { usage: PROD_TURN }), price: GATEWAY });
    const summary = (await runSetupAgent(w.input)).setupRunSummary;
    expect(w.reports.length).toBeGreaterThan(0);
    const once = await booked(w);
    const twice = await booked(w, 2);
    expect(once.money.state).toBe("partial");
    expect(once.money.spentMicros.state).toBe("available");
    const spent = once.money.spentMicros.state === "available" ? once.money.spentMicros.value : 0;
    // The booked cost is max(the cheap catalog table, the run's own figure): never below the budget's count, which is never below the gateway's settle.
    expect(spent).toBeGreaterThanOrEqual(Math.floor(12 * PROD_SETTLE_USD * 1_000_000));
    expect(spent).toBeGreaterThanOrEqual((summary.spendCents - 1) * 10_000);
    expect(twice.money.spentMicros).toEqual(once.money.spentMicros);
  });

  it("a run that spent nothing books nothing (an empty report would be charged a floor)", async () => {
    const w = await world({ turns: [], price: GATEWAY });
    await runSetupAgent(w.input);
    expect(w.reports).toEqual([]);
  });

  it("a run that ends on its budget still books what it spent", async () => {
    const w = await world({ turns: turns(20, { usage: PROD_TURN }), price: GATEWAY, budgetCents: 100 });
    expect((await runSetupAgent(w.input)).setupRunSummary.stop).toBe("budget_used");
    expect(w.reports.length).toBeGreaterThan(0);
    const { money } = await booked(w);
    expect(money.spentMicros.state).toBe("available");
  });

  it("a call that began and failed with no usage is booked by the broker as a missing-usage call (awaiting usage), not at the worker's reserve", async () => {
    const w = await world({ turns: [{ stopReason: "error", errorMessage: "the provider dropped the stream" }], price: { inputPerMTok: 10, outputPerMTok: 50 }, budgetCents: 5_000 });
    const summary = (await runSetupAgent(w.input)).setupRunSummary;
    expect(summary.spendCents).toBeGreaterThanOrEqual(84);
    expect(w.reports.every((payload) => ((payload["costUsd"] as number | null) ?? 0) < 0.01)).toBe(true);
    expect(w.reports.reduce((sum, payload) => sum + ((payload["usageMissingCalls"] as number | undefined) ?? 0), 0)).toBe(1);
    const { money } = await booked(w);
    expect(money.awaitingUsageCalls).toEqual({ state: "available", value: 1 });
  });

  it("the stand-in writer is its own report, with the cents the cap counted for it; a writer that spent nothing reports nothing", () => {
    const stats = { tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 50_000, total: 50_200 }, cost: 0 };
    const payload = writerUsagePayload({ stats, model: { provider: "p", modelId: "m" }, spendCents: 31 }, undefined, "SUCCEEDED");
    expect(payload).toMatchObject({ provider: "p", modelId: "m", tokens: { cacheWrite: 50_000 } });
    expect((payload as { costUsd: number }).costUsd).toBeGreaterThanOrEqual(0.31);
    const empty = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    expect(writerUsagePayload({ stats: empty, model: { provider: "p", modelId: "m" }, spendCents: 0 }, undefined, "SUCCEEDED")).toBeUndefined();
    // A writer cut off with no usage seen is counted at its ceiling by the cap: that is booked too.
    expect(writerUsagePayload({ stats: empty, model: { provider: "p", modelId: "m" }, spendCents: 12 }, undefined, "SUCCEEDED")).toMatchObject({ costUsd: 0.12 });
  });
});
