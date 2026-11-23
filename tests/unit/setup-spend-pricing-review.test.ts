// Setup spend pricing: Opus money review tests (2cea25029). The prod replay (about 40 calls settled at about $0.96 must not show 4x), the routed laptop price keeping the catalog's cache rates,
// and a transient provider error before any reply (a 429 / overloaded, retried by Pi) that the gateway never settled.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT } from "../../packages/contracts/src/index.js";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";
import { routeUsageIdentity } from "../../packages/model-runtime/src/index.js";
import { setupModelPrice, type ModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { runSetupAgent, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "b".repeat(40);
/** The gateway's run price for a Sonnet-class model: input 3, output 15, cache read 0.3, cache write bound 6 (the 1 hour write; a 5 minute write is 3.75). */
const GATEWAY: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 6 };
interface Turn { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string; errorMessage?: string }

async function run(turns: Turn[], price: ModelPrice, budgetCents: number, reportedCost = 0) {
  const rootPath = await mkdtemp(join(tmpdir(), "setup-spend-review-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const listeners: Array<(event: unknown) => void> = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let aborted = false;
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f",
    prompt: async () => {
      for (const turn of turns) {
        if (aborted) break;
        const u = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        totals.input += u.input ?? 0; totals.output += u.output ?? 0; totals.cacheRead += u.cacheRead ?? 0; totals.cacheWrite += u.cacheWrite ?? 0;
        totals.total += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        // Pi's own shape: an error message carries a zeroed usage, never none.
        for (const l of listeners) l({ type: "message_end", message: { role: "assistant", stopReason: turn.stopReason ?? "toolUse", ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }), content: turn.stopReason === "error" ? [] : [{ type: "text", text: "working" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...u } } });
      }
    },
    abort: async () => { aborted = true; },
    getModel: () => ({ provider: "rovara-route", modelId: "claude-sonnet-4-6" }), getSessionStats: () => ({ cost: reportedCost, tokens: { ...totals } }) as never,
    subscribe: (l) => { listeners.push(l); return () => undefined; }, dispose: () => undefined,
  };
  const base: BashOperations = { exec: async () => ({ exitCode: 0 }) };
  const network: RunNetwork = { name: "agentx-setup-0123456789ab", subnet: "x", gateway: "x", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => [], stop: async () => undefined };
  const ports: SetupRunPorts = {
    startNetwork: async () => network, createSandbox: () => ({ bashOperations: () => base, dispose: async () => undefined, fileOpsTarget: () => ({}) }) as never,
    openSession: async () => session, callback: async () => ({ hosts: [] }), progress: async () => undefined, register: () => () => undefined, checkFiles: async () => ({ ok: true }), tickMs: 50,
    beforeStart: async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set<string>()]]) }),
    reportUsage: async () => undefined,
  };
  const input: SetupRunInput = {
    rootPath, operationId: "22222222-2222-4222-8222-222222222222", basedOnRevision: 1, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, budgetCents }, price,
    repositories: [{ name: "web", path: "repo/web", resolvedCommit: COMMIT }], commits: [{ repository: "web", commit: COMMIT }], ports,
  };
  return (await runSetupAgent(input)).setupRunSummary;
}

/** The prod run's shape: 40 calls, the context growing from 16K to about 55K and read from the cache, a small write and some output per call. */
function prodTurns(): Turn[] {
  return Array.from({ length: 40 }, (_, i) => ({ usage: { input: 300, cacheRead: 16_000 + i * 1_000, cacheWrite: 1_000, output: 600 } }));
}
/** What the gateway settles for one of them (a 5 minute write at 3.75). */
const settle = (t: Turn) => ((t.usage!.input ?? 0) * 3 + (t.usage!.output ?? 0) * 15 + (t.usage!.cacheRead ?? 0) * 0.3 + (t.usage!.cacheWrite ?? 0) * 3.75) / 1_000_000;

describe("Opus review: the prod numbers through the new pricing", () => {
  it("40 calls the gateway settled at about $0.96 show about $1, not $3.82, and a $4.00 run is not stopped at its budget", async () => {
    const turns = prodTurns();
    const settled = turns.reduce((sum, t) => sum + settle(t), 0);
    expect(settled).toBeGreaterThan(0.9);
    expect(settled).toBeLessThan(1.0);
    const summary = await run(turns, GATEWAY, 400);
    expect(summary.stop).not.toBe("budget_used");
    // Never below the gateway; above it only by the 1 hour write bound on the write tokens (40K x (6 - 3.75) = 9 cents) and rounding.
    expect(summary.spendCents).toBeGreaterThanOrEqual(Math.ceil(settled * 100));
    expect(summary.spendCents).toBeLessThanOrEqual(Math.ceil(settled * 100) + 10);
    // The old arithmetic on the same run: one rate = 6 for every input-side token, plus a quarter more on writes.
    const old = turns.reduce((sum, t) => sum + ((300 + t.usage!.cacheRead! + 1_000 + 250) * 6 + 600 * 15) / 1_000_000, 0);
    expect(old / settled).toBeGreaterThan(3.5);
  });
});

describe("Opus review: the routed laptop price keeps the catalog's cache rates", () => {
  it("a routed model whose catalog lists cache rates is priced at them (not at the read = input, write = 2 x input fallback)", () => {
    const route = { alias: "claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" } as const;
    const listed = listPricesPerMillion(routeUsageIdentity(route));
    expect(listed).toBeDefined();
    expect(listed!.cacheRead).toBeGreaterThan(0);
    expect(listed!.cacheWrite).toBeGreaterThan(0);
    const price = setupModelPrice({ provider: "rovara-route", modelId: route.alias }, route);
    expect(price).toEqual({ inputPerMTok: listed!.input, outputPerMTok: listed!.output, cacheReadPerMTok: listed!.cacheRead, cacheWritePerMTok: listed!.cacheWrite });
  });
});

describe("Opus review: a transient error before any reply is not money spent", () => {
  it("a 429 retried by Pi (3 attempts, zero usage, nothing streamed) adds no reserve: the run is not stopped and its spend stays at the real turns", async () => {
    // Context at 130K: the reserve is (130K + 1K + 1,024) x 6 + 8,192 x 15 = about 92 cents per failed attempt. Pi retries a 429 twice (PI_MODEL_RETRY.maxRetries = 2): three message_end errors.
    const big: Turn = { usage: { input: 1_000, cacheRead: 129_000, cacheWrite: 0, output: 1_000 } };
    const rateLimited: Turn = { stopReason: "error", errorMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-minute rate limit\"}}" };
    const turns: Turn[] = [big, rateLimited, rateLimited, rateLimited, big, big];
    const real = 3 * (1_000 * 3 + 129_000 * 0.3 + 1_000 * 15) / 1_000_000;
    const summary = await run(turns, GATEWAY, 400);
    expect(summary.stop).not.toBe("budget_used");
    expect(summary.spendCents).toBeLessThanOrEqual(Math.ceil(real * 100) + 1);
  });
});

describe("Opus delta review (cc0581fd5)", () => {
  const big: Turn = { usage: { input: 1_000, cacheRead: 129_000, cacheWrite: 0, output: 1_000 } };
  const rateLimited: Turn = { stopReason: "error", errorMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"rate limit\"}}" };
  it("a 429 on the run's FIRST call (retried by Pi, the session reporting a cost of 0) is known zero spend, not unreadable spend: the run is not stopped at its budget", async () => {
    const summary = await run([rateLimited, rateLimited, rateLimited, big, big], GATEWAY, 400);
    expect(summary.stop).not.toBe("budget_used");
  });
  it("never lower than the session's own reported cost (the larger of the two totals is kept)", async () => {
    const summary = await run([{ usage: { input: 1_000, output: 10 } }], GATEWAY, 1_000, 2.5);
    expect(summary.spendCents).toBeGreaterThanOrEqual(250);
  });
});
